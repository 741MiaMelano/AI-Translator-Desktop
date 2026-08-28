import assert from "node:assert/strict";
import test from "node:test";
import { __testables } from "../../backend/asr/runtime-process.mjs";

const { forwardWhisperProgress } = __testables;

function collect() {
  const seen = [];
  return { seen, onProgress: (event) => seen.push(event.progress) };
}

test("whisper progress is parsed from whole lines and never reported twice", () => {
  const { seen, onProgress } = collect();
  const forward = forwardWhisperProgress(onProgress);
  forward(Buffer.from("whisper_print_progress_callback: progress =   5%\n"));
  forward(Buffer.from("whisper_print_progress_callback: progress =  10%\n"));
  // 同一个百分比 whisper 会连着打好几次，不该把同一个数字报两遍
  forward(Buffer.from("whisper_print_progress_callback: progress =  10%\n"));
  forward(Buffer.from("whisper_print_progress_callback: progress = 100%\n"));
  assert.deepEqual(seen, [5, 10, 100]);
});

test("whisper progress survives being split across chunk boundaries", () => {
  const { seen, onProgress } = collect();
  const forward = forwardWhisperProgress(onProgress);
  // 子进程的 data 事件切在哪里是不确定的：一行可能被劈成两块
  forward(Buffer.from("whisper_print_progress_callback: prog"));
  assert.deepEqual(seen, [], "half a line must not report anything");
  forward(Buffer.from("ress =  42%\nnoise line\n"));
  assert.deepEqual(seen, [42]);
});

test("whisper progress ignores unrelated output and keeps the carry bounded", () => {
  const { seen, onProgress } = collect();
  const forward = forwardWhisperProgress(onProgress);
  forward(Buffer.from("whisper_model_load: loading model\n[00:00:03.060 --> 00:00:05.000]  Hey\n"));
  assert.deepEqual(seen, []);
  // 长时间运行时不能让未完成的那一段无限增长
  forward(Buffer.from("x".repeat(20_000)));
  forward(Buffer.from(" progress =  7%\n"));
  assert.deepEqual(seen, [7]);
});

test("no progress sink means no listener is installed at all", () => {
  assert.equal(forwardWhisperProgress(undefined), undefined);
  assert.equal(forwardWhisperProgress(null), undefined);
});
