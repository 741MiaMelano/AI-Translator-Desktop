import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { transferModelStorage } from "../../backend/settings/model-storage-transfer.mjs";

test("model storage transfer verifies before switching and only removes managed source data", async () => {
  const root = mkdtempSync(join(tmpdir(), "asr-storage-transfer-"));
  const source = join(root, "old");
  const destination = join(root, "new");
  mkdirSync(join(source, "models", "small"), { recursive: true });
  mkdirSync(join(source, "runtimes", "cpu"), { recursive: true });
  const qwenPython = join(source, "runtimes", "qwen-runtime", "python", "cpython-3.12.13-windows-x86_64-none");
  mkdirSync(qwenPython, { recursive: true });
  mkdirSync(join(source, "runtimes", "qwen-runtime", "venv"), { recursive: true });
  mkdirSync(destination);
  writeFileSync(join(source, "models", "small", "model.bin"), "model");
  writeFileSync(join(source, "runtimes", "cpu", "runtime.exe"), "runtime");
  writeFileSync(join(qwenPython, "python.exe"), "python");
  writeFileSync(join(source, "runtimes", "qwen-runtime", "venv", "pyvenv.cfg"), `home = ${qwenPython}\n`);
  symlinkSync(join(root, "deleted-staging-python"), join(source, "runtimes", "qwen-runtime", "python", "cpython-3.12-windows-x86_64-none"), process.platform === "win32" ? "junction" : "dir");
  writeFileSync(join(source, "keep.txt"), "user file");
  let savedPath = null;
  const progress = [];
  try {
    const result = await transferModelStorage({
      sourceRoot: source,
      destinationRoot: destination,
      commit: (path) => { savedPath = path; },
      onProgress: (event) => progress.push(event),
    });
    assert.equal(savedPath, destination);
    assert.equal(result.fileCount, 4);
    assert.equal(readFileSync(join(destination, "models", "small", "model.bin"), "utf8"), "model");
    assert.equal(existsSync(join(destination, "runtimes", "qwen-runtime", "python", "cpython-3.12-windows-x86_64-none")), false);
    assert.equal(existsSync(join(source, "models")), false);
    assert.equal(readFileSync(join(source, "keep.txt"), "utf8"), "user file");
    assert.deepEqual([...new Set(progress.map((event) => event.stage))], ["scanning", "copying", "verifying", "switching", "cleaning", "completed"]);
    assert.equal(progress.at(-1).progress, 100);

    const failedSource = join(root, "failed-old");
    const failedDestination = join(root, "failed-new");
    mkdirSync(join(failedSource, "models", "small"), { recursive: true });
    mkdirSync(failedDestination);
    writeFileSync(join(failedSource, "models", "small", "model.bin"), "still safe");
    await assert.rejects(() => transferModelStorage({
      sourceRoot: failedSource,
      destinationRoot: failedDestination,
      commit: () => { throw new Error("settings write failed"); },
    }), /settings write failed/);
    assert.equal(readFileSync(join(failedSource, "models", "small", "model.bin"), "utf8"), "still safe");
    assert.deepEqual(readdirSync(failedDestination), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
