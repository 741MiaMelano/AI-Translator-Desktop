import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createAsrDeviceSelector } from "../backend/asr/device-selector.mjs";
import { createAsrRuntimeProcess } from "../backend/asr/runtime-process.mjs";
import { createAsrRuntimePort } from "../backend/asr/runtime-registry.mjs";

const appOwnedRoot = process.argv[2];
const manifestPath = process.argv[3] ?? "docs/third-party/asr/manifest.json";
assert.equal(typeof appOwnedRoot, "string", "managed ASR root argument is required");
assert.equal(isAbsolute(appOwnedRoot), true, "managed ASR root must be absolute");

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const runtimePort = createAsrRuntimePort({
  manifest,
  appOwnedRoot,
  platform: process.platform,
  arch: process.arch,
});
const runtimeProcess = createAsrRuntimeProcess();
let persistedState = null;
const selector = createAsrDeviceSelector({
  getCapabilityStatus: () => runtimePort.getCapabilityStatus(),
  resolveRuntime: (device) => runtimePort.resolveReadyRuntime(device),
  resolveProbeRuntime: (device) => runtimePort.resolveReadyRuntimeForProbe(device),
  probeRuntime: ({ operationId, runtime }) => runtimeProcess.probe({ operationId, runtime }),
  cancelProbe: ({ operationId }) => runtimeProcess.cancel(operationId),
  loadState: () => persistedState,
  saveState: (state) => { persistedState = structuredClone(state); },
});

try {
  const status = await selector.detect({ operationId: "phase7-cpu-device-smoke" });
  assert.equal(status.detection.cpu.status, "available");
  process.stdout.write(`${JSON.stringify({
    engineId: "whisper.cpp",
    engineVersion: "1.9.1",
    device: "cpu",
    runtimeId: status.detection.cpu.runtimeId,
    runtimeVersion: status.detection.cpu.runtimeVersion,
    available: true,
    cudaStatus: status.detection.cuda.status,
  })}\n`);
} finally {
  runtimeProcess.close();
}
