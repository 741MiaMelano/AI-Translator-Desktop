import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

const SECRET_KEY = /secret|token|password|api.?key|authorization|credential/i;
const CONTENT_KEY = /subtitle|transcript|prompt|sourceText|targetText|content|text$/i;
const PATH_KEY = /path|directory|dir$/i;
const WINDOWS_PATH = /\b[A-Za-z]:[\\/](?:[^\\/\s:"<>|?*]+[\\/])*[^\\/\s:"<>|?*]*/g;

function redactString(input) {
  return String(input)
    .slice(0, 4_096)
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9._-]{8,}\b/g, "[REDACTED]")
    .replace(WINDOWS_PATH, "[REDACTED_PATH]")
    .replace(/https:\/\/[^\s"']+/gi, (value) => {
      try {
        const url = new URL(value);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.href;
      } catch {
        return "[REDACTED_URL]";
      }
    });
}

export function redactDiagnosticValue(value, key = "", depth = 0) {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (CONTENT_KEY.test(key)) return "[REDACTED_CONTENT]";
  if (PATH_KEY.test(key)) return "[REDACTED_PATH]";
  if (depth > 8) return "[REDACTED_DEPTH]";
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redactDiagnosticValue(item, "", depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).slice(0, 200).map(([childKey, child]) => [
        childKey,
        redactDiagnosticValue(child, childKey, depth + 1),
      ]),
    );
  }
  return String(value);
}

export function createStructuredLogger({ logsDir, now = () => new Date(), maxBytes = 5 * 1024 * 1024 }) {
  mkdirSync(logsDir, { recursive: true });
  const logPath = join(logsDir, "app.jsonl");
  function write(level, event, details) {
    const entry = {
      timestamp: now().toISOString(),
      level,
      event: typeof event === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(event) ? event : "invalid_event",
      details: redactDiagnosticValue(details ?? {}),
    };
    const line = `${JSON.stringify(entry)}\n`;
    if (existsSync(logPath) && statSync(logPath).size + Buffer.byteLength(line) > maxBytes) {
      const rotated = `${logPath}.1`;
      rmSync(rotated, { force: true });
      renameSync(logPath, rotated);
    }
    appendFileSync(logPath, line, "utf8");
  }
  return {
    info: (event, details) => write("info", event, details),
    warn: (event, details) => write("warn", event, details),
    error: (event, details) => write("error", event, details),
  };
}

function readLogs(logsDir) {
  const entries = [];
  for (const name of ["app.jsonl.1", "app.jsonl"]) {
    const path = join(logsDir, name);
    if (!existsSync(path)) continue;
    const bytes = readFileSync(path);
    const tail = bytes.subarray(Math.max(0, bytes.length - 256 * 1024)).toString("utf8");
    for (const line of tail.split(/\r?\n/).filter(Boolean).slice(-1_000)) {
      try {
        entries.push(redactDiagnosticValue(JSON.parse(line)));
      } catch {
        entries.push({ level: "warn", event: "invalid_log_entry" });
      }
    }
  }
  return entries;
}

export function createDiagnosticsService({
  logsDir,
  getCapabilities,
  getSettingsSummary,
  runtimeInfo,
  selectOutputFile,
  now = () => new Date(),
}) {
  async function preview() {
    const createdAt = now().toISOString();
    const entries = [
      { name: "manifest.json", value: { schemaVersion: 1, createdAt, runtime: runtimeInfo } },
      { name: "capabilities.json", value: await getCapabilities() },
      { name: "settings.json", value: getSettingsSummary() },
      { name: "logs.json", value: readLogs(logsDir) },
    ].map(({ name, value }) => ({ name, content: `${JSON.stringify(redactDiagnosticValue(value), null, 2)}\n` }));
    return {
      createdAt,
      entries,
      totalBytes: entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.content), 0),
    };
  }

  return {
    preview,
    async exportPackage() {
      const contents = await preview();
      const selection = await selectOutputFile({ suggestedName: "ai-translator-diagnostics.json" });
      if (selection?.canceled || !selection?.filePath) return { canceled: true };
      if (!isAbsolute(selection.filePath)) throw new Error("Diagnostic output path must be absolute");
      mkdirSync(dirname(selection.filePath), { recursive: true });
      const entriesJson = JSON.stringify(contents.entries);
      const packageValue = {
        format: "ai-translator-diagnostics",
        schemaVersion: 1,
        createdAt: contents.createdAt,
        entriesSha256: createHash("sha256").update(entriesJson).digest("hex"),
        entries: contents.entries,
      };
      const bytes = Buffer.from(`${JSON.stringify(packageValue)}\n`, "utf8");
      writeFileSync(selection.filePath, bytes, { flag: "wx" });
      return { canceled: false, fileName: selection.filePath.split(/[\\/]/).pop(), sizeBytes: bytes.length };
    },
  };
}
