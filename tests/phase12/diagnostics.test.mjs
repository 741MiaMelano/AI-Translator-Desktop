import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDiagnosticsService, createStructuredLogger } from "../../backend/support/diagnostics.mjs";

test("structured logs and diagnostic preview redact secrets, paths and subtitle bodies", async () => {
  const root = mkdtempSync(join(tmpdir(), "phase12-diagnostics-"));
  const logsDir = join(root, "logs");
  const secret = "sk-phase12-super-secret";
  const subtitle = "This private subtitle must never leave the machine";
  const privatePath = "C:\\Users\\Le\\Private\\movie.srt";
  const logger = createStructuredLogger({ logsDir, now: () => new Date("2026-07-23T10:00:00.000Z") });
  try {
    logger.info("provider.failed", {
      apiKey: secret,
      filePath: privatePath,
      subtitleText: subtitle,
      message: `Bearer ${secret} failed while reading ${privatePath}`,
    });
    const service = createDiagnosticsService({
      logsDir,
      getCapabilities: async () => ({ ready: false, reason: privatePath }),
      getSettingsSummary: () => ({ cachePath: privatePath, downloadSource: "mirror" }),
      runtimeInfo: { platform: "win32", arch: "x64", version: "0.1.0" },
      selectOutputFile: async () => ({ canceled: false, filePath: join(root, "support.json") }),
      now: () => new Date("2026-07-23T11:00:00.000Z"),
    });
    const preview = await service.preview();
    const serialized = JSON.stringify(preview);
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes(subtitle), false);
    assert.equal(serialized.includes("Users\\Le"), false);
    assert.equal(serialized.includes("[REDACTED]"), true);
    assert.ok(preview.entries.some(({ name }) => name === "logs.json"));

    const exported = await service.exportPackage();
    assert.equal(exported.canceled, false);
    assert.equal(existsSync(join(root, "support.json")), true);
    const packageText = readFileSync(join(root, "support.json"), "utf8");
    assert.equal(packageText.includes(secret), false);
    assert.equal(packageText.includes(subtitle), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
