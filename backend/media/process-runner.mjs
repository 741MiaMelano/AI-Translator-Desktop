import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { MEDIA_ERROR_CODES, MEDIA_LIMITS, MINIMAL_PROCESS_ENV_KEYS } from "./constants.mjs";

function mediaError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sanitizeMessage(message, tail = false) {
  const sanitized = String(message || "Media process failed")
    .replace(/[A-Za-z]:\\[^\s"'\]|,]+/g, "[path]")
    .replace(/\/(?:Users|home|tmp|var)\/[^\s"']+/g, "[path]")
    .replace(/\bstack=[^\s]+/gi, "stack=[redacted]")
    .replace(/\bat\s+\S+\s*\([^)]*\)/g, "[frame]");
  return tail
    ? sanitized.slice(-MEDIA_LIMITS.STDERR_SUMMARY_MAX_CHARS)
    : sanitized.slice(0, MEDIA_LIMITS.STDERR_SUMMARY_MAX_CHARS);
}

function buildMinimalEnv(overrides = {}) {
  const env = {
    // Explicit empty PATH: never inherit host PATH for lookup of ffmpeg/ffprobe.
    PATH: "",
    Path: "",
  };
  for (const key of MINIMAL_PROCESS_ENV_KEYS) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (!env.TEMP && !env.TMP) {
    env.TEMP = tmpdir();
    env.TMP = tmpdir();
  }
  if (!env.SYSTEMROOT && !env.SystemRoot && process.platform === "win32") {
    env.SYSTEMROOT = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
    env.SystemRoot = env.SYSTEMROOT;
  }
  if (!env.WINDIR && !env.windir && process.platform === "win32") {
    env.WINDIR = env.SYSTEMROOT || env.SystemRoot;
    env.windir = env.WINDIR;
  }
  return { ...env, ...overrides };
}

export function resolveAppOwnedWorkDir(baseTempDir = tmpdir()) {
  const dir = join(baseTempDir, "desktop-ai-translator-media-work", randomUUID());
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function assertRunnableExe(absoluteExe) {
  if (typeof absoluteExe !== "string" || absoluteExe.trim().length === 0) {
    throw mediaError(MEDIA_ERROR_CODES.INVALID_INPUT, "Executable path is required");
  }
  if (!isAbsolute(absoluteExe)) {
    throw mediaError(MEDIA_ERROR_CODES.INVALID_INPUT, "Executable must be an absolute path");
  }
  const normalized = normalize(absoluteExe);
  if (!normalized.toLowerCase().endsWith(".exe")) {
    throw mediaError(MEDIA_ERROR_CODES.INVALID_INPUT, "Executable must be a .exe file");
  }
  if (!existsSync(normalized)) {
    throw mediaError(MEDIA_ERROR_CODES.NOT_AVAILABLE, "Managed media executable is not available");
  }
  let st;
  try {
    st = statSync(normalized);
  } catch {
    throw mediaError(MEDIA_ERROR_CODES.NOT_AVAILABLE, "Managed media executable is not available");
  }
  if (!st.isFile()) {
    throw mediaError(MEDIA_ERROR_CODES.INVALID_INPUT, "Executable path must be a file");
  }
  return normalized;
}

function killProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* ignore */
      }
    }
    return;
  }
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
  const taskkill = join(systemRoot, "System32", "taskkill.exe");
  try {
    const killer = spawn(taskkill, ["/PID", String(pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
      env: buildMinimalEnv(),
    });
    killer.unref?.();
  } catch {
    /* ignore */
  }
}

/**
 * Run a managed absolute executable with hard output bounds.
 * @returns {Promise<{ exitCode: number, stdout: Buffer, stderrSummary: string, pid: number|null }>}
 */
export function runManagedProcess({
  absoluteExe,
  argv = [],
  cwd,
  timeoutMs = MEDIA_LIMITS.PROBE_TIMEOUT_MS,
  stdoutMaxBytes = MEDIA_LIMITS.STDOUT_MAX_BYTES_PROBE,
  stderrMaxBytes = MEDIA_LIMITS.STDERR_MAX_BYTES,
  includeRawStderr = false,
  signal,
  envOverrides = {},
  spawnImpl = spawn,
  onSpawn,
  onStdout,
  truncateStderr = false,
}) {
  let exe;
  try {
    exe = assertRunnableExe(absoluteExe);
  } catch (error) {
    return Promise.reject(error);
  }
  if (!Array.isArray(argv) || argv.some((item) => typeof item !== "string")) {
    return Promise.reject(mediaError(MEDIA_ERROR_CODES.INVALID_INPUT, "argv must be a string array"));
  }
  if (onSpawn !== undefined && typeof onSpawn !== "function") {
    return Promise.reject(mediaError(MEDIA_ERROR_CODES.INVALID_INPUT, "onSpawn must be a function"));
  }
  if (onStdout !== undefined && typeof onStdout !== "function") {
    return Promise.reject(mediaError(MEDIA_ERROR_CODES.INVALID_INPUT, "onStdout must be a function"));
  }
  if (typeof truncateStderr !== "boolean") {
    return Promise.reject(mediaError(MEDIA_ERROR_CODES.INVALID_INPUT, "truncateStderr must be a boolean"));
  }
  const workDir = cwd && typeof cwd === "string" ? cwd : resolveAppOwnedWorkDir();
  if (!isAbsolute(workDir)) {
    return Promise.reject(mediaError(MEDIA_ERROR_CODES.INVALID_INPUT, "cwd must be absolute"));
  }
  try {
    mkdirSync(workDir, { recursive: true });
  } catch (error) {
    return Promise.reject(mediaError(MEDIA_ERROR_CODES.PROCESS_FAILED, sanitizeMessage(error?.message)));
  }

  const env = buildMinimalEnv(envOverrides);
  const spawnOptions = {
    shell: false,
    windowsHide: true,
    cwd: workDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  };

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(exe, argv, spawnOptions);
    } catch (error) {
      reject(mediaError(MEDIA_ERROR_CODES.PROCESS_FAILED, sanitizeMessage(error?.message)));
      return;
    }

    const pid = child.pid ?? null;
    try {
      if (pid) onSpawn?.(pid);
    } catch {
      if (pid) killProcessTree(pid);
      reject(mediaError(MEDIA_ERROR_CODES.PROCESS_FAILED, "Process ownership registration failed"));
      return;
    }
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let capturedStderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let outputTooLarge = false;
    let stderrTruncated = false;

    const settleReject = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const settleResolve = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const forceKill = () => {
      if (pid) killProcessTree(pid);
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    };

    let graceTimer = null;
    const requestStop = () => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      graceTimer = setTimeout(() => forceKill(), MEDIA_LIMITS.CANCEL_GRACE_MS);
      graceTimer.unref?.();
    };

    const onAbort = () => {
      cancelled = true;
      requestStop();
    };

    const cleanup = () => {
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      if (signal) {
        try {
          signal.removeEventListener("abort", onAbort);
        } catch {
          /* ignore */
        }
      }
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.removeAllListeners();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      requestStop();
    }, timeoutMs);
    timer.unref?.();

    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.stdout?.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buf.length;
      if (stdoutBytes > stdoutMaxBytes) {
        outputTooLarge = true;
        requestStop();
        return;
      }
      stdoutChunks.push(buf);
      try {
        onStdout?.(buf);
      } catch {
        /* progress reporting must not affect the managed process */
      }
    });

    child.stderr?.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes += buf.length;
      if (!truncateStderr && stderrBytes > stderrMaxBytes) {
        outputTooLarge = true;
        requestStop();
        return;
      }
      stderrChunks.push(buf);
      capturedStderrBytes += buf.length;
      while (truncateStderr && capturedStderrBytes > stderrMaxBytes && stderrChunks.length) {
        stderrTruncated = true;
        const overflow = capturedStderrBytes - stderrMaxBytes;
        if (overflow < stderrChunks[0].length) {
          stderrChunks[0] = Buffer.from(stderrChunks[0].subarray(overflow));
          capturedStderrBytes -= overflow;
        } else {
          capturedStderrBytes -= stderrChunks.shift().length;
        }
      }
    });

    child.on("error", (error) => {
      settleReject(mediaError(MEDIA_ERROR_CODES.PROCESS_FAILED, sanitizeMessage(error?.message)));
    });

    child.on("close", (code) => {
      if (graceTimer) clearTimeout(graceTimer);
      if (outputTooLarge) {
        settleReject(mediaError(MEDIA_ERROR_CODES.OUTPUT_TOO_LARGE, "Process output exceeded the allowed limit"));
        return;
      }
      if (cancelled) {
        settleReject(mediaError(MEDIA_ERROR_CODES.CANCELLED, "Media process was cancelled"));
        return;
      }
      if (timedOut) {
        settleReject(mediaError(MEDIA_ERROR_CODES.TIMEOUT, "Media process timed out"));
        return;
      }
      const exitCode = typeof code === "number" ? code : 1;
      const stderr = Buffer.concat(stderrChunks);
      const stderrRaw = stderr.toString("utf8");
      const stderrSummary = sanitizeMessage(stderrRaw, stderrTruncated);
      if (exitCode !== 0) {
        settleReject(
          mediaError(MEDIA_ERROR_CODES.PROCESS_FAILED, stderrSummary || "Media process exited with a non-zero code"),
        );
        return;
      }
      const result = {
        exitCode,
        stdout: Buffer.concat(stdoutChunks),
        stdoutBytes,
        stderrSummary,
        pid,
        spawnOptions: { shell: spawnOptions.shell, cwd: spawnOptions.cwd, envKeys: Object.keys(env).sort() },
      };
      if (includeRawStderr) result.stderr = stderr;
      settleResolve(result);
    });
  });
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export { killProcessTree, buildMinimalEnv, sanitizeMessage, mediaError };
