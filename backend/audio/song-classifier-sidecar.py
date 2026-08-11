#!/usr/bin/env python
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Offline speech/music/noise classification for subtitle song handling.

The feature extraction and smoothing parameters follow inaSpeechSegmenter SMN.
The original Keras weights are loaded into an equivalent PyTorch network so the
application can reuse its existing optional PyTorch runtime without TensorFlow.

Feature-extraction portions are adapted from SIDEKIT. This readable sidecar is
distributed under LGPL-3.0-or-later; the package includes the LGPL and GPL text.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from pathlib import Path

import h5py
import numpy as np
import soundfile as sf
import torch
import torch.nn as nn
import torch.nn.functional as functional


LABELS = ("speech", "music", "noise")
SAMPLE_RATE = 16_000
FRAME_MS = 20
MODEL_ID = "ina-speech-music-noise-v1"
MODEL_SHA256 = "f04b5e3c86fa2e81666d106b0867350fe7858c7bd006c2a74c27b5b45507e7d8"


def _fail(message: str) -> None:
    raise RuntimeError(message)


def _safe_file(value: str, field: str) -> Path:
    path = Path(value).resolve(strict=True)
    if not path.is_file() or path.is_symlink():
        _fail(f"{field} is invalid")
    return path


def _hz_to_mel(value: np.ndarray | float) -> np.ndarray | float:
    return 2595.0 * np.log10(1.0 + np.asarray(value) / 700.0)


def _mel_to_hz(value: np.ndarray | float) -> np.ndarray | float:
    return 700.0 * (10.0 ** (np.asarray(value) / 2595.0) - 1.0)


def _filter_bank(n_fft: int = 512, filters: int = 24) -> np.ndarray:
    low_mel = _hz_to_mel(100.0)
    high_mel = _hz_to_mel(8_000.0)
    frequencies = _mel_to_hz(np.linspace(low_mel, high_mel, filters + 2))
    heights = 2.0 / (frequencies[2:] - frequencies[:-2])
    bank = np.zeros((filters, n_fft // 2 + 1), dtype=np.float32)
    fft_frequencies = np.arange(n_fft, dtype=np.float32) / n_fft * SAMPLE_RATE
    for index in range(filters):
        low, center, high = frequencies[index:index + 3]
        left = np.arange(math.floor(low * n_fft / SAMPLE_RATE) + 1,
                         math.floor(center * n_fft / SAMPLE_RATE) + 1, dtype=np.int32)
        right = np.arange(math.floor(center * n_fft / SAMPLE_RATE) + 1,
                          min(math.floor(high * n_fft / SAMPLE_RATE) + 1, n_fft), dtype=np.int32)
        if left.size:
            bank[index, left] = heights[index] / (center - low) * (fft_frequencies[left] - low)
        if right.size > 1:
            usable = right[:-1]
            bank[index, usable] = heights[index] / (high - center) * (high - fft_frequencies[usable])
    return bank


FILTER_BANK = _filter_bank()


def _frames(signal: np.ndarray, size: int = 400, shift: int = 160) -> np.ndarray:
    if signal.size < size:
        signal = np.pad(signal, (0, size - signal.size))
    count = (signal.size - size) // shift + 1
    shape = (count, size)
    strides = (signal.strides[0] * shift, signal.strides[0])
    return np.lib.stride_tricks.as_strided(signal, shape=shape, strides=strides).copy()


def _features(signal: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    framed = _frames(signal.astype(np.float32, copy=False))
    emphasized = framed - np.concatenate((framed[:, :1], framed[:, :-1]), axis=1) * 0.97
    log_energy = np.log(np.maximum(np.sum(emphasized * emphasized, axis=1), 1e-30))
    spectrum = np.abs(np.fft.rfft(emphasized * np.hanning(400), 512, axis=1)) ** 2
    mel = np.log(np.maximum(np.dot(spectrum, FILTER_BANK.T), 1e-30)).astype(np.float32)
    return mel, log_energy


def _patches(mel: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    original_length = mel.shape[0]
    if original_length < 68:
        floor = float(np.min(mel)) if mel.size else -30.0
        mel = np.concatenate((mel, np.full((68 - original_length, 24), floor, dtype=np.float32)))
    windows = np.lib.stride_tricks.sliding_window_view(mel, (68, mel.shape[1]))[::2, 0]
    flat = windows.reshape(windows.shape[0], -1)
    means = flat.mean(axis=1, keepdims=True)
    deviations = flat.std(axis=1, keepdims=True)
    finite = np.isfinite(flat).all(axis=1) & (deviations[:, 0] > 0)
    flat = np.divide(flat - means, deviations, out=np.zeros_like(flat), where=deviations > 0)
    windows = flat.reshape(-1, 68, mel.shape[1])
    left = np.repeat(windows[:1], 17, axis=0)
    right_count = 16 + mel.shape[0] % 2
    right = np.repeat(windows[-1:], right_count, axis=0)
    patches = np.concatenate((left, windows, right), axis=0)
    patch_finite = np.concatenate((np.repeat(finite[:1], 17), finite, np.repeat(finite[-1:], right_count)))
    if original_length < 68:
        remove = (68 - original_length) // 2
        if remove:
            patches = patches[:-remove]
            patch_finite = patch_finite[:-remove]
    return patches[:, :, :21], patch_finite


def _viterbi(emission: np.ndarray, transition_cost: float) -> np.ndarray:
    samples, states = emission.shape
    transition = np.full((states, states), transition_cost, dtype=np.float64)
    np.fill_diagonal(transition, 0.0)
    scores = np.empty((samples, states), dtype=np.float64)
    paths = np.empty((samples, states), dtype=np.int32)
    scores[0] = emission[0] - math.log(states)
    paths[0] = np.arange(states)
    for index in range(1, samples):
        candidates = scores[index - 1][:, None] + transition
        paths[index] = np.argmax(candidates, axis=0)
        scores[index] = emission[index] + candidates[paths[index], np.arange(states)]
    result = np.empty(samples, dtype=np.int32)
    result[-1] = int(np.argmax(scores[-1]))
    for index in range(samples - 2, -1, -1):
        result[index] = paths[index + 1, result[index + 1]]
    return result


class InaSmn(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.convs = nn.ModuleList([
            nn.Conv2d(1, 64, (7, 4)),
            nn.Conv2d(64, 128, (3, 3)),
            nn.Conv2d(128, 128, (3, 3)),
            nn.Conv2d(128, 256, (3, 3)),
        ])
        self.conv_bns = nn.ModuleList([
            nn.BatchNorm2d(64, eps=0.001),
            nn.BatchNorm2d(128, eps=0.001),
            nn.BatchNorm2d(128, eps=0.001),
            nn.BatchNorm2d(256, eps=0.001),
        ])
        self.dense = nn.ModuleList([nn.Linear(256, 256) for _ in range(4)])
        self.dense_bns = nn.ModuleList([nn.BatchNorm1d(256, eps=0.001) for _ in range(4)])
        self.output = nn.Linear(256, 3)

    def forward(self, value: torch.Tensor) -> torch.Tensor:
        value = value.unsqueeze(1)
        value = functional.relu(self.conv_bns[0](self.convs[0](value)))
        value = functional.max_pool2d(functional.pad(value, (0, 0, 1, 1), value=float("-inf")), (4, 2), (4, 2))
        value = functional.relu(self.conv_bns[1](self.convs[1](value)))
        value = functional.relu(self.conv_bns[2](self.convs[2](value)))
        value = functional.max_pool2d(functional.pad(value, (0, 1, 0, 0), value=float("-inf")), (2, 2), (2, 2))
        value = functional.relu(self.conv_bns[3](self.convs[3](value)))
        value = functional.max_pool2d(value, (4, 1), (4, 1)).flatten(1)
        for layer, normalizer in zip(self.dense, self.dense_bns):
            value = functional.relu(normalizer(layer(value)))
        return torch.softmax(self.output(value), dim=1)


def _copy_conv(layer: nn.Conv2d, handle: h5py.File, name: str) -> None:
    root = handle[f"model_weights/{name}/{name}"]
    layer.weight.data.copy_(torch.from_numpy(np.asarray(root["kernel:0"]).transpose(3, 2, 0, 1)))
    layer.bias.data.copy_(torch.from_numpy(np.asarray(root["bias:0"])))


def _copy_dense(layer: nn.Linear, handle: h5py.File, name: str) -> None:
    root = handle[f"model_weights/{name}/{name}"]
    layer.weight.data.copy_(torch.from_numpy(np.asarray(root["kernel:0"]).T))
    layer.bias.data.copy_(torch.from_numpy(np.asarray(root["bias:0"])))


def _copy_bn(layer: nn.modules.batchnorm._BatchNorm, handle: h5py.File, name: str) -> None:
    root = handle[f"model_weights/{name}/{name}"]
    layer.weight.data.copy_(torch.from_numpy(np.asarray(root["gamma:0"])))
    layer.bias.data.copy_(torch.from_numpy(np.asarray(root["beta:0"])))
    layer.running_mean.data.copy_(torch.from_numpy(np.asarray(root["moving_mean:0"])))
    layer.running_var.data.copy_(torch.from_numpy(np.asarray(root["moving_variance:0"])))


def _load_model(path: Path, device: torch.device) -> InaSmn:
    model = InaSmn()
    with h5py.File(path, "r") as handle:
        for layer, name in zip(model.convs, ("conv2d_12", "conv2d_13", "conv2d_14", "conv2d_15")):
            _copy_conv(layer, handle, name)
        for layer, name in zip(model.conv_bns, ("batch_normalization_15", "batch_normalization_16", "batch_normalization_17", "batch_normalization_18")):
            _copy_bn(layer, handle, name)
        for layer, name in zip(model.dense, ("dense_6", "dense_7", "dense_8", "dense_9")):
            _copy_dense(layer, handle, name)
        for layer, name in zip(model.dense_bns, ("batch_normalization_19", "batch_normalization_20", "batch_normalization_21", "batch_normalization_22")):
            _copy_bn(layer, handle, name)
        _copy_dense(model.output, handle, "dense_10")
    return model.to(device).eval()


def _predict(model: InaSmn, patches: np.ndarray, device: torch.device, batch_size: int) -> np.ndarray:
    outputs: list[np.ndarray] = []
    with torch.inference_mode():
        for start in range(0, len(patches), batch_size):
            batch = torch.from_numpy(patches[start:start + batch_size]).to(device)
            outputs.append(model(batch).cpu().numpy())
    return np.concatenate(outputs) if outputs else np.empty((0, 3), dtype=np.float32)


def _classify_chunk(model: InaSmn, signal: np.ndarray, device: torch.device, batch_size: int) -> list[dict]:
    mel, log_energy = _features(signal)
    patches, finite = _patches(mel)
    count = min(len(patches), (len(log_energy) + 1) // 2)
    patches, finite = patches[:count], finite[:count]
    finite_energy = log_energy[np.isfinite(log_energy)]
    threshold = float(np.mean(finite_energy) + np.log(0.03)) if finite_energy.size else float("inf")
    active = (log_energy > threshold)[::2][:count]
    probabilities = np.full((count, 3), 1 / 3, dtype=np.float32)
    indices = np.flatnonzero(active & finite)
    if indices.size:
        probabilities[indices] = _predict(model, patches[indices], device, batch_size)
    probabilities[~active] = (0.0, 0.0, 1.0)
    labels = _viterbi(np.log(np.maximum(probabilities, 1e-10)), -80 * np.log(10.0))
    intervals: list[dict] = []
    start = 0
    for index in range(1, len(labels) + 1):
        if index < len(labels) and labels[index] == labels[start]:
            continue
        label = int(labels[start])
        confidence = float(np.mean(probabilities[start:index, label]))
        intervals.append({
            "label": LABELS[label],
            "startMs": start * FRAME_MS,
            "endMs": min(round(len(signal) / SAMPLE_RATE * 1000), index * FRAME_MS),
            "confidence": round(confidence, 6),
        })
        start = index
    return intervals


def _merge(intervals: list[dict], duration_ms: int) -> list[dict]:
    result: list[dict] = []
    for interval in intervals:
        interval["startMs"] = max(0, min(duration_ms, int(interval["startMs"])))
        interval["endMs"] = max(interval["startMs"] + 1, min(duration_ms, int(interval["endMs"])))
        if result and result[-1]["label"] == interval["label"] and interval["startMs"] <= result[-1]["endMs"] + FRAME_MS:
            left_duration = result[-1]["endMs"] - result[-1]["startMs"]
            right_duration = interval["endMs"] - interval["startMs"]
            total = left_duration + right_duration
            result[-1]["confidence"] = round((result[-1]["confidence"] * left_duration + interval["confidence"] * right_duration) / max(1, total), 6)
            result[-1]["endMs"] = interval["endMs"]
        else:
            result.append(dict(interval))
    return result


def _plan_music(intervals: list[dict]) -> tuple[list[dict], list[dict]]:
    filtered: list[dict] = []
    uncertain: list[dict] = []
    for interval in intervals:
        if interval["label"] != "music":
            continue
        duration = interval["endMs"] - interval["startMs"]
        # INA's smoothed label is deliberately sticky; 0.70 is already a strong
        # mean posterior over a two-second-or-longer interval.
        if duration >= 2_000 and interval["confidence"] >= 0.70:
            start = interval["startMs"] + 200
            end = interval["endMs"] - 200
            if end - start >= 1_200:
                filtered.append({"startMs": start, "endMs": end})
                continue
        uncertain.append({"startMs": interval["startMs"], "endMs": interval["endMs"]})
    return filtered, uncertain


def _write_filtered_audio(input_path: Path, output_path: Path, intervals: list[dict]) -> None:
    with sf.SoundFile(input_path, "r") as source:
        if source.samplerate != SAMPLE_RATE or source.channels != 1:
            _fail("input audio must be 16 kHz mono PCM")
        with sf.SoundFile(output_path, "w", samplerate=SAMPLE_RATE, channels=1, format="WAV", subtype="PCM_16") as target:
            frame = 0
            interval_index = 0
            while True:
                block = source.read(16_000, dtype="float32", always_2d=False)
                if block.size == 0:
                    break
                block_start, block_end = frame, frame + len(block)
                while interval_index < len(intervals) and intervals[interval_index]["endMs"] * 16 <= block_start:
                    interval_index += 1
                index = interval_index
                while index < len(intervals) and intervals[index]["startMs"] * 16 < block_end:
                    mute_start = max(block_start, intervals[index]["startMs"] * 16) - block_start
                    mute_end = min(block_end, intervals[index]["endMs"] * 16) - block_start
                    block[int(mute_start):int(mute_end)] = 0
                    index += 1
                target.write(block)
                frame = block_end


def classify(args: argparse.Namespace) -> dict:
    input_path = _safe_file(args.input, "input")
    model_path = _safe_file(args.model, "model")
    output_json = Path(args.output_json).resolve()
    output_audio = Path(args.output_audio).resolve()
    if output_json.exists() or output_audio.exists() or output_json.parent != output_audio.parent:
        _fail("output paths are invalid")
    device = torch.device("cuda" if args.device == "cuda" and torch.cuda.is_available() else "cpu")
    if args.device == "cuda" and device.type != "cuda":
        _fail("CUDA is unavailable")
    model = _load_model(model_path, device)
    intervals: list[dict] = []
    with sf.SoundFile(input_path, "r") as source:
        if source.samplerate != SAMPLE_RATE or source.channels != 1:
            _fail("input audio must be 16 kHz mono")
        total_frames = len(source)
        duration_ms = max(1, round(total_frames / SAMPLE_RATE * 1000))
        chunk_frames = args.chunk_seconds * SAMPLE_RATE
        offset_frames = 0
        while offset_frames < total_frames:
            signal = source.read(min(chunk_frames, total_frames - offset_frames), dtype="float32", always_2d=False)
            local = _classify_chunk(model, signal, device, args.batch_size)
            offset_ms = round(offset_frames / SAMPLE_RATE * 1000)
            for interval in local:
                interval["startMs"] += offset_ms
                interval["endMs"] += offset_ms
                intervals.append(interval)
            offset_frames += len(signal)
            print(json.dumps({"type": "progress", "progress": min(100, round(offset_frames / total_frames * 100))}), flush=True)
    intervals = _merge(intervals, duration_ms)
    filtered, uncertain = _plan_music(intervals)
    _write_filtered_audio(input_path, output_audio, filtered)
    result = {
        "schemaVersion": 1,
        "detector": MODEL_ID,
        "modelHash": MODEL_SHA256,
        "device": device.type,
        "durationMs": duration_ms,
        "filteredIntervals": filtered,
        "uncertainIntervals": uncertain,
    }
    output_json.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-check", action="store_true")
    parser.add_argument("--input")
    parser.add_argument("--model")
    parser.add_argument("--output-json")
    parser.add_argument("--output-audio")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument("--chunk-seconds", type=int, default=600)
    parser.add_argument("--batch-size", type=int, default=256)
    args = parser.parse_args()
    if args.self_check:
        if args.model:
            _load_model(_safe_file(args.model, "model"), torch.device("cpu"))
        print(json.dumps({"ok": True, "detector": MODEL_ID, "torch": torch.__version__, "h5py": h5py.__version__}))
        return 0
    if not all((args.input, args.model, args.output_json, args.output_audio)):
        _fail("classification arguments are incomplete")
    if not 60 <= args.chunk_seconds <= 3_600 or not 1 <= args.batch_size <= 2_048:
        _fail("classification bounds are invalid")
    result = classify(args)
    print(json.dumps({"type": "complete", "filtered": len(result["filteredIntervals"]), "uncertain": len(result["uncertainIntervals"])}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"type": "error", "message": str(error)[:240]}), file=sys.stderr, flush=True)
        raise SystemExit(2)
