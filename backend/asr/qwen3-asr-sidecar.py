from __future__ import annotations

import argparse
import dataclasses
import importlib.util
import json
import math
import os
import re
import shutil
import sys
import tempfile
import wave
from pathlib import Path

def prepare_nagisa_import() -> tempfile.TemporaryDirectory[str] | None:
    spec = importlib.util.find_spec("nagisa")
    if not spec or not spec.submodule_search_locations:
        return None
    source = Path(next(iter(spec.submodule_search_locations)))
    if str(source).isascii():
        return None
    shadow = tempfile.TemporaryDirectory(prefix="ai-translator-qwen-nagisa-")
    destination = Path(shadow.name) / "nagisa"
    if not str(destination).isascii():
        shadow.cleanup()
        raise RuntimeError("Qwen3-ASR requires an ASCII temporary directory on Windows")
    shutil.copytree(source, destination)
    sys.path.insert(0, shadow.name)
    return shadow


SAMPLE_RATE = 16_000
MAX_CHUNK_MS = 10_000
MERGE_GAP_MS = 300
PAD_MS = 120
MAX_CHECKPOINT_BYTES = 128 * 1024 * 1024
MAX_VAD_INTERVAL_BYTES = 16 * 1024 * 1024
MAX_VAD_INTERVALS = 100_000
STREAM_READ_FRAMES = SAMPLE_RATE
ENERGY_WINDOW_FRAMES = SAMPLE_RATE // 100
SILENCE_TOP_DB = 35
MAX_CONTRACT_DURATION_MS = 12 * 60 * 60 * 1_000
MIN_RETRY_CHUNK_MS = 1_250


def json_value(value):
    if dataclasses.is_dataclass(value):
        return {field.name: json_value(getattr(value, field.name)) for field in dataclasses.fields(value)}
    if isinstance(value, (list, tuple)):
        return [json_value(item) for item in value]
    if isinstance(value, dict):
        return {str(key): json_value(item) for key, item in value.items()}
    if hasattr(value, "item"):
        return value.item()
    return value


def empty_result() -> list[dict]:
    return [{"language": "", "text": "", "time_stamps": None}]


def plausible_result(value, duration_ms: int) -> bool:
    if not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], dict):
        return False
    result = value[0]
    text = result.get("text")
    if not isinstance(text, str):
        return False
    if not text.strip():
        return result.get("time_stamps") is None
    stamps = result.get("time_stamps")
    items = stamps.get("items") if isinstance(stamps, dict) else None
    if not isinstance(items, list) or not items:
        return False
    if len(text) > max(256, duration_ms // 10) or len(items) > max(32, duration_ms // 40):
        return False
    normalized = [str(item.get("text", "")).strip().casefold() for item in items if isinstance(item, dict)]
    if len(normalized) >= 64 and len(set(normalized)) * 8 < len(normalized):
        return False
    cursor = 0
    previous_end = 0.0
    maximum = duration_ms / 1_000 + 0.5
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get("text"), str) or not item["text"]:
            return False
        position = text.find(item["text"], cursor)
        if position < 0:
            return False
        cursor = position + len(item["text"])
        start = item.get("start_time")
        end = item.get("end_time")
        if (isinstance(start, bool) or isinstance(end, bool) or not isinstance(start, (int, float)) or
                not isinstance(end, (int, float)) or not math.isfinite(start) or not math.isfinite(end) or
                start < previous_end or end < start or end > maximum):
            return False
        previous_end = end
    return True


def merge_results(parts: list[tuple[int, list[dict]]]) -> list[dict]:
    populated = [(index, offset_ms, value[0]) for index, (offset_ms, value) in enumerate(parts)
                 if value and value[0].get("text", "").strip()]
    if not populated:
        return empty_result()
    text_parts = []
    items = []
    language = ""
    for index, offset_ms, result in populated:
        language = language or str(result.get("language", ""))
        text_parts.append(str(result["text"]))
        offset = offset_ms / 1_000
        upper = parts[index + 1][0] / 1_000 if index + 1 < len(parts) else math.inf
        for item in result["time_stamps"]["items"]:
            start = min(item["start_time"] + offset, upper)
            items.append({
                **item,
                "start_time": start,
                "end_time": min(max(item["end_time"] + offset, start), upper),
            })
    return [{"language": language, "text": " ".join(text_parts), "time_stamps": {"items": items}}]


def recognize_chunk(model, source, temporary: Path, index: int, start: int, end: int, language) -> list[dict]:
    chunk_path = temporary / f"chunk-{index:05d}-{start}-{end}.wav"
    write_pcm_chunk(source, chunk_path, start, end)
    result = json_value(model.transcribe(audio=str(chunk_path), language=language, return_time_stamps=True))
    duration_ms = round((end - start) / SAMPLE_RATE * 1_000)
    if plausible_result(result, duration_ms):
        return result
    if duration_ms <= MIN_RETRY_CHUNK_MS:
        return empty_result()
    middle = start + (end - start) // 2
    left = recognize_chunk(model, source, temporary, index, start, middle, language)
    right = recognize_chunk(model, source, temporary, index, middle, end, language)
    merged = merge_results([(0, left), (round((middle - start) / SAMPLE_RATE * 1_000), right)])
    return merged if plausible_result(merged, duration_ms) else empty_result()


def pcm_frame_count(source) -> int:
    if (source.getnchannels() != 1 or source.getsampwidth() != 2 or source.getframerate() != SAMPLE_RATE or
            source.getcomptype() != "NONE" or source.getnframes() <= 0):
        raise RuntimeError("Qwen3-ASR requires a 16kHz mono PCM-16 WAV")
    return source.getnframes()


def energy_blocks(source, total_frames: int, on_read=None):
    import numpy as np

    position = 0
    while position < total_frames:
        requested = min(STREAM_READ_FRAMES, total_frames - position)
        payload = source.readframes(requested)
        if len(payload) != requested * 2:
            raise RuntimeError("PCM WAV ended before its declared frame count")
        if on_read is not None:
            on_read(requested)
        samples = np.frombuffer(payload, dtype="<i2").astype(np.float32)
        complete = len(samples) // ENERGY_WINDOW_FRAMES
        energies = np.mean(
            np.square(samples[:complete * ENERGY_WINDOW_FRAMES].reshape(complete, ENERGY_WINDOW_FRAMES)),
            axis=1,
            dtype=np.float64,
        ) if complete else np.empty(0, dtype=np.float64)
        if complete * ENERGY_WINDOW_FRAMES < len(samples):
            energies = np.append(energies, np.mean(np.square(samples[complete * ENERGY_WINDOW_FRAMES:]), dtype=np.float64))
        yield position, requested, energies
        position += requested


def detect_speech_intervals(open_source, on_read=None) -> tuple[int, list[tuple[int, int]]]:
    with open_source() as source:
        total_frames = pcm_frame_count(source)
        peak_energy = max((float(energies.max()) for _, _, energies in energy_blocks(source, total_frames, on_read)), default=0)
    if peak_energy <= 0:
        return total_frames, []

    threshold = peak_energy * 10 ** (-SILENCE_TOP_DB / 10)
    chunks: list[tuple[int, int]] = []
    merge_gap = SAMPLE_RATE * MERGE_GAP_MS // 1000
    padding = SAMPLE_RATE * PAD_MS // 1000
    maximum = SAMPLE_RATE * MAX_CHUNK_MS // 1000
    active_start = None
    pending: list[int] | None = None

    def split_pending() -> None:
        nonlocal pending
        if pending is None:
            return
        start, end = pending
        while end - start > maximum:
            chunks.append((start, start + maximum))
            start += maximum
        if end > start:
            chunks.append((start, end))
        pending = None

    def accept(start: int, end: int) -> None:
        nonlocal pending
        start = max(0, start - padding)
        end = min(total_frames, end + padding)
        if pending is not None and start - pending[1] <= merge_gap:
            pending[1] = max(pending[1], end)
        else:
            split_pending()
            pending = [start, end]

    with open_source() as source:
        if pcm_frame_count(source) != total_frames:
            raise RuntimeError("PCM WAV changed during recognition")
        for block_start, block_frames, energies in energy_blocks(source, total_frames, on_read):
            for index, voiced in enumerate(energies > threshold):
                start = block_start + index * ENERGY_WINDOW_FRAMES
                end = min(block_start + block_frames, start + ENERGY_WINDOW_FRAMES)
                if voiced and active_start is None:
                    active_start = start
                elif not voiced and active_start is not None:
                    accept(active_start, start)
                    active_start = None
        if active_start is not None:
            accept(active_start, total_frames)
    split_pending()
    return total_frames, chunks


def speech_intervals(audio_path: Path, on_read=None) -> tuple[int, list[tuple[int, int]]]:
    return detect_speech_intervals(lambda: wave.open(str(audio_path), "rb"), on_read)


def load_vad_intervals(path: Path, duration_ms: int, total_frames: int) -> tuple[list[tuple[int, int]], dict]:
    try:
        stat = path.lstat()
        if path.is_symlink() or not path.is_file() or stat.st_size <= 0 or stat.st_size > MAX_VAD_INTERVAL_BYTES:
            raise RuntimeError("Silero VAD interval artifact is invalid")
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise RuntimeError("Silero VAD interval artifact is invalid") from error
    if not isinstance(value, dict) or set(value) != {"schemaVersion", "mediaDurationMs", "activity"} or \
            value.get("schemaVersion") != 1 or value.get("mediaDurationMs") != duration_ms:
        raise RuntimeError("Silero VAD interval contract is invalid")
    activity = value.get("activity")
    if not isinstance(activity, dict) or set(activity) != {"detector", "mode", "speechIntervals", "excludedIntervals"} or \
            activity.get("detector") != "silero-vad-v6.2.0" or activity.get("mode") not in {"auto", "custom"}:
        raise RuntimeError("Silero VAD activity contract is invalid")

    def validate(items, label):
        if not isinstance(items, list) or len(items) > MAX_VAD_INTERVALS:
            raise RuntimeError(f"Silero VAD {label} interval count is invalid")
        normalized = []
        previous_end = 0
        for item in items:
            if not isinstance(item, dict) or set(item) != {"startMs", "endMs"}:
                raise RuntimeError(f"Silero VAD {label} interval is invalid")
            start = item.get("startMs")
            end = item.get("endMs")
            if isinstance(start, bool) or isinstance(end, bool) or not isinstance(start, int) or not isinstance(end, int) or \
                    start < previous_end or end <= start or end > duration_ms:
                raise RuntimeError(f"Silero VAD {label} interval time is invalid")
            normalized.append({"startMs": start, "endMs": end})
            previous_end = end
        return normalized

    speech = validate(activity.get("speechIntervals"), "speech")
    excluded = validate(activity.get("excludedIntervals"), "excluded")
    if not speech:
        raise RuntimeError("Silero VAD did not detect any speech")
    expected_excluded = []
    cursor = 0
    for item in speech:
        if item["startMs"] > cursor:
            expected_excluded.append({"startMs": cursor, "endMs": item["startMs"]})
        cursor = item["endMs"]
    if cursor < duration_ms:
        expected_excluded.append({"startMs": cursor, "endMs": duration_ms})
    if excluded != expected_excluded:
        raise RuntimeError("Silero VAD excluded intervals do not complement speech")

    maximum = SAMPLE_RATE * MAX_CHUNK_MS // 1_000
    intervals = []
    for item in speech:
        start = min(total_frames, round(item["startMs"] / 1_000 * SAMPLE_RATE))
        end = min(total_frames, round(item["endMs"] / 1_000 * SAMPLE_RATE))
        while end - start > maximum:
            intervals.append((start, start + maximum))
            start += maximum
        if end > start:
            intervals.append((start, end))
    if not intervals:
        raise RuntimeError("Silero VAD intervals are outside the audio contract")
    return intervals, {**activity, "speechIntervals": speech, "excludedIntervals": excluded}


def contract_intervals(total_frames: int, intervals: list[tuple[int, int]], duration_ms: int) -> list[tuple[int, int]]:
    if duration_ms <= 0 or duration_ms > MAX_CONTRACT_DURATION_MS:
        raise RuntimeError("ASR media duration contract is invalid")
    actual_duration_ms = round(total_frames / SAMPLE_RATE * 1_000)
    tolerance_ms = min(5_000, max(500, duration_ms // 1_000))
    if abs(actual_duration_ms - duration_ms) > tolerance_ms:
        raise RuntimeError("Extracted PCM duration does not match the media duration contract")
    contract_frames = min(total_frames, round(duration_ms / 1_000 * SAMPLE_RATE))
    return [(start, min(end, contract_frames)) for start, end in intervals if start < contract_frames and min(end, contract_frames) > start]


def write_pcm_chunk(source, output_path: Path, start: int, end: int) -> None:
    source.setpos(start)
    remaining = end - start
    with wave.open(str(output_path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(SAMPLE_RATE)
        while remaining:
            requested = min(STREAM_READ_FRAMES, remaining)
            payload = source.readframes(requested)
            if len(payload) != requested * 2:
                raise RuntimeError("PCM WAV ended while creating a recognition chunk")
            output.writeframesraw(payload)
            remaining -= requested


def segment_bounds(interval: tuple[int, int], duration_ms: int) -> tuple[int, int]:
    start, end = interval
    return round(start / SAMPLE_RATE * 1_000), min(duration_ms, round(end / SAMPLE_RATE * 1_000))


def load_checkpoint(path: Path | None, fingerprint: str, duration_ms: int, intervals: list[tuple[int, int]]) -> list[dict]:
    if path is None:
        return []
    try:
        if path.lstat().st_size <= 0 or path.lstat().st_size > MAX_CHECKPOINT_BYTES or path.is_symlink():
            return []
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return []
    if not isinstance(value, dict):
        return []
    if set(value) != {"schemaVersion", "fingerprint", "mediaDurationMs", "segments"}:
        return []
    segments = value.get("segments")
    if (value.get("schemaVersion") != 1 or value.get("fingerprint") != fingerprint or
            value.get("mediaDurationMs") != duration_ms or not isinstance(segments, list)):
        return []
    if len(segments) > len(intervals):
        return []
    for index, segment in enumerate(segments):
        if not isinstance(segment, dict) or set(segment) != {"startMs", "endMs", "result"}:
            return []
        if (segment.get("startMs"), segment.get("endMs")) != segment_bounds(intervals[index], duration_ms):
            return []
    return segments


def atomic_write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".partial", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def output_value(duration_ms: int, segments: list[dict], activity: dict | None = None) -> dict:
    return {
        "schemaVersion": 1,
        "mediaDurationMs": duration_ms,
        "segments": segments,
        **({"activity": activity} if activity is not None else {}),
    }


def checkpoint_value(fingerprint: str, duration_ms: int, segments: list[dict]) -> dict:
    return {"schemaVersion": 1, "fingerprint": fingerprint, "mediaDurationMs": duration_ms, "segments": segments}


def report_progress(completed: int, total: int, previous: int | None) -> int:
    progress = completed * 100 // total
    if progress != previous:
        print(json.dumps({
            "type": "progress",
            "progress": progress,
            "completedChunks": completed,
            "totalChunks": total,
        }), flush=True)
    return progress


def load_qwen_model_class():
    shadow = prepare_nagisa_import()
    from qwen_asr import Qwen3ASRModel

    return Qwen3ASRModel, shadow


def self_check() -> None:
    import numpy as np
    import torch

    _, nagisa_shadow = load_qwen_model_class()
    assert nagisa_shadow is None or Path(nagisa_shadow.name).is_dir()
    assert json_value({"ok": np.int64(1)}) == {"ok": 1}
    print(json.dumps({"ok": True, "torch": torch.__version__, "cuda": torch.cuda.is_available()}))


def checkpoint_self_check() -> None:
    intervals = [(0, SAMPLE_RATE), (SAMPLE_RATE, SAMPLE_RATE * 2)]
    segment = {"startMs": 0, "endMs": 1_000, "result": [{"text": "ok"}]}
    fingerprint = "a" * 64
    with tempfile.TemporaryDirectory(prefix="qwen3-asr-checkpoint-check-") as temporary:
        path = Path(temporary) / "checkpoint.json"
        atomic_write_json(path, checkpoint_value(fingerprint, 2_000, [segment]))
        assert load_checkpoint(path, fingerprint, 2_000, intervals) == [segment]
        assert load_checkpoint(path, "b" * 64, 2_000, intervals) == []
        assert load_checkpoint(path, fingerprint, 2_001, intervals) == []
        assert not list(path.parent.glob("*.partial"))
    print(json.dumps({"ok": True, "checkpoint": "atomic-resume"}))


def streaming_self_check() -> None:
    import numpy as np

    duration_seconds = 2 * 60 * 60
    total_frames = duration_seconds * SAMPLE_RATE
    payload = np.full(STREAM_READ_FRAMES, 1_000, dtype="<i2").tobytes()
    maximum_read = 0

    class SyntheticPcmWav:
        def __init__(self):
            self.position = 0

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def getnchannels(self):
            return 1

        def getsampwidth(self):
            return 2

        def getframerate(self):
            return SAMPLE_RATE

        def getcomptype(self):
            return "NONE"

        def getnframes(self):
            return total_frames

        def readframes(self, requested):
            available = min(requested, total_frames - self.position)
            self.position += available
            return payload if available == STREAM_READ_FRAMES else payload[:available * 2]

    def observed(frames: int) -> None:
        nonlocal maximum_read
        maximum_read = max(maximum_read, frames)

    first = detect_speech_intervals(SyntheticPcmWav, observed)
    second = detect_speech_intervals(SyntheticPcmWav, observed)
    assert first == second
    assert first[0] == total_frames
    assert len(first[1]) == duration_seconds * 1_000 // MAX_CHUNK_MS
    assert maximum_read <= STREAM_READ_FRAMES
    contract_duration_ms = 4_000
    actual_frames = round(4_200 / 1_000 * SAMPLE_RATE)
    clamped = contract_intervals(actual_frames, [(0, actual_frames)], contract_duration_ms)
    assert segment_bounds(clamped[0], contract_duration_ms) == (0, contract_duration_ms)
    repeated = [{
        "language": "English",
        "text": " ".join(["again"] * 80),
        "time_stamps": {"items": [{"text": "again", "start_time": 0.0, "end_time": 0.0}] * 80},
    }]
    assert not plausible_result(repeated, 10_000)
    assert not plausible_result([{"language": "English", "text": "Yes, Yes", "time_stamps": {"items": [
        {"text": "YesYes", "start_time": 0.0, "end_time": 0.5},
    ]}}], 1_000)
    assert not plausible_result([{"language": "English", "text": "one two", "time_stamps": {"items": [
        {"text": "one", "start_time": 0.0, "end_time": 0.8},
        {"text": "two", "start_time": 0.5, "end_time": 1.0},
    ]}}], 1_000)
    left = [{"language": "English", "text": "hello", "time_stamps": {"items": [
        {"text": "hello", "start_time": 0.0, "end_time": 0.5},
    ]}}]
    right = [{"language": "English", "text": "world", "time_stamps": {"items": [
        {"text": "world", "start_time": 0.0, "end_time": 0.5},
    ]}}]
    merged = merge_results([(0, left), (5_000, right)])[0]
    assert merged["text"] == "hello world" and merged["time_stamps"]["items"][-1]["start_time"] == 5.0
    overlapping_left = [{"language": "Hindi", "text": "left", "time_stamps": {"items": [
        {"text": "left", "start_time": 0.8, "end_time": 1.12},
    ]}}]
    overlapping_right = [{"language": "English", "text": "right", "time_stamps": {"items": [
        {"text": "right", "start_time": 0.0, "end_time": 0.08},
    ]}}]
    boundary = merge_results([(0, overlapping_left), (1_090, overlapping_right)])
    boundary_items = boundary[0]["time_stamps"]["items"]
    assert boundary_items[0]["end_time"] == boundary_items[1]["start_time"] == 1.09
    assert plausible_result(boundary, 2_180)
    print(json.dumps({
        "ok": True,
        "durationMs": duration_seconds * 1_000,
        "intervalCount": len(first[1]),
        "maxReadFrames": maximum_read,
        "contractDurationMs": contract_duration_ms,
        "actualDurationMs": 4_200,
    }))


def probe(device: str) -> None:
    import torch

    _, nagisa_shadow = load_qwen_model_class()
    assert nagisa_shadow is None or Path(nagisa_shadow.name).is_dir()
    if device != "cuda" or not torch.cuda.is_available():
        raise SystemExit("CUDA is required for Qwen3-ASR Preview")
    left = torch.ones((16, 16), device="cuda", dtype=torch.bfloat16)
    assert torch.mm(left, left).shape == (16, 16)
    print(json.dumps({
        "available": True,
        "device": "cuda",
        "torch": torch.__version__,
        "cudaRuntime": torch.version.cuda,
        "deviceName": torch.cuda.get_device_name(),
        "capability": list(torch.cuda.get_device_capability()),
    }))


def transcribe(args: argparse.Namespace) -> None:
    import torch

    Qwen3ASRModel, nagisa_shadow = load_qwen_model_class()
    assert nagisa_shadow is None or Path(nagisa_shadow.name).is_dir()
    model_path = Path(args.model).resolve(strict=True)
    aligner_path = Path(args.aligner).resolve(strict=True)
    audio_path = Path(args.audio).resolve(strict=True)
    output_path = Path(args.output).resolve()
    checkpoint_path = Path(args.checkpoint).resolve() if args.checkpoint else None
    fingerprint = args.fingerprint or ""
    if checkpoint_path is not None and not re.fullmatch(r"[a-f0-9]{64}", fingerprint):
        raise SystemExit("A valid fingerprint is required with --checkpoint")
    if not torch.cuda.is_available():
        raise SystemExit("CUDA is required for Qwen3-ASR Preview")

    try:
        duration_ms = int(args.duration_ms)
    except (TypeError, ValueError):
        raise SystemExit("A valid --duration-ms is required")
    activity = None
    if args.speech_intervals:
        with wave.open(str(audio_path), "rb") as source:
            total_frames = pcm_frame_count(source)
        intervals, activity = load_vad_intervals(Path(args.speech_intervals).resolve(strict=True), duration_ms, total_frames)
    else:
        total_frames, intervals = speech_intervals(audio_path)
    intervals = contract_intervals(total_frames, intervals, duration_ms)
    if not intervals:
        raise SystemExit("No speech was detected")

    language = None if args.language == "auto" else args.language
    segments = load_checkpoint(checkpoint_path, fingerprint, duration_ms, intervals)
    last_progress = report_progress(len(segments), len(intervals), None)
    model = None
    if len(segments) < len(intervals):
        common = {"dtype": torch.bfloat16, "device_map": "cuda", "attn_implementation": "eager"}
        model = Qwen3ASRModel.from_pretrained(
            str(model_path),
            forced_aligner=str(aligner_path),
            forced_aligner_kwargs=common,
            max_inference_batch_size=1,
            max_new_tokens=512,
            **common,
        )
    with wave.open(str(audio_path), "rb") as source:
        if pcm_frame_count(source) != total_frames:
            raise RuntimeError("PCM WAV changed during recognition")
        with tempfile.TemporaryDirectory(prefix="qwen3-asr-chunks-", dir=output_path.parent) as temporary:
            for index, (start, end) in enumerate(intervals[len(segments):], start=len(segments)):
                result = recognize_chunk(model, source, Path(temporary), index, start, end, language)
                start_ms, end_ms = segment_bounds((start, end), duration_ms)
                segments.append({
                    "startMs": start_ms,
                    "endMs": end_ms,
                    "result": result,
                })
                if checkpoint_path is not None:
                    atomic_write_json(checkpoint_path, checkpoint_value(fingerprint, duration_ms, segments))
                last_progress = report_progress(len(segments), len(intervals), last_progress)
    atomic_write_json(output_path, output_value(duration_ms, segments, activity))
    print(json.dumps({"ok": True, "segmentCount": len(segments), "pid": os.getpid()}))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Managed Qwen3-ASR Preview sidecar")
    parser.add_argument("command", nargs="?", choices=("probe", "transcribe", "checkpoint-self-check", "streaming-self-check"))
    parser.add_argument("--self-check", action="store_true")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--model")
    parser.add_argument("--aligner")
    parser.add_argument("--audio")
    parser.add_argument("--output")
    parser.add_argument("--checkpoint")
    parser.add_argument("--fingerprint")
    parser.add_argument("--duration-ms")
    parser.add_argument("--speech-intervals")
    parser.add_argument("--language", default="auto")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.self_check:
        self_check()
    elif args.command == "checkpoint-self-check":
        checkpoint_self_check()
    elif args.command == "streaming-self-check":
        streaming_self_check()
    elif args.command == "probe":
        probe(args.device)
    elif args.command == "transcribe" and all((args.model, args.aligner, args.audio, args.output, args.duration_ms)):
        transcribe(args)
    else:
        raise SystemExit("transcribe requires --model, --aligner, --audio, --output and --duration-ms")


if __name__ == "__main__":
    main()
