import { asrEngineForModelId, isAsrModelId } from "../../shared/asr-model-ids.mjs";

const REQUESTED_DEVICES = new Set(["auto", "cpu", "cuda"]);
const ACTUAL_DEVICES = new Set(["cpu", "cuda"]);
const FALLBACK_REASONS = new Set([
  "cuda_not_ready",
  "cuda_probe_failed",
  "cuda_initialization_failed",
]);
const DETECTION_STATES = new Set(["not_detected", "available", "unavailable"]);

function fail(code, message, retryable = false) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  return error;
}

function validatePreference(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !REQUESTED_DEVICES.has(value.requestedDevice) ||
    typeof value.allowCudaFallback !== "boolean"
  ) {
    throw fail("INVALID_INPUT", "ASR device preference is invalid");
  }
  return {
    requestedDevice: value.requestedDevice,
    allowCudaFallback: value.allowCudaFallback,
  };
}

function safeOperationId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) {
    throw fail("INVALID_INPUT", "operationId is invalid");
  }
  return value;
}

function safeDetection(value, device) {
  if (!value || typeof value !== "object" || !DETECTION_STATES.has(value.status)) return null;
  if (
    typeof value.runtimeId !== "string" ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(value.runtimeId) ||
    typeof value.runtimeVersion !== "string" ||
    value.runtimeVersion.length === 0 ||
    value.runtimeVersion.length > 64
  ) {
    return null;
  }
  const result = {
    status: value.status,
    runtimeId: value.runtimeId,
    runtimeVersion: value.runtimeVersion,
  };
  if (value.reason !== undefined) {
    const allowed = device === "cuda"
      ? new Set(["runtime_not_ready", "probe_failed", "initialization_failed"])
      : new Set(["runtime_not_ready", "probe_failed"]);
    if (!allowed.has(value.reason)) return null;
    result.reason = value.reason;
  }
  return result;
}

function defaultState() {
  return {
    requestedDevice: "auto",
    allowCudaFallback: false,
    actualDevice: null,
    actualRuntimeId: null,
    actualRuntimeVersion: null,
    fallbackReason: null,
    detection: { cpu: null, cuda: null },
    updatedAt: null,
  };
}

function normalizeState(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaultState();
  if (!REQUESTED_DEVICES.has(raw.requestedDevice) || typeof raw.allowCudaFallback !== "boolean") {
    return defaultState();
  }
  const candidateActualDevice = raw.actualDevice === null || raw.actualDevice === undefined
    ? null
    : ACTUAL_DEVICES.has(raw.actualDevice) ? raw.actualDevice : null;
  const fallbackReason = raw.fallbackReason === null || raw.fallbackReason === undefined
    ? null
    : FALLBACK_REASONS.has(raw.fallbackReason) ? raw.fallbackReason : null;
  const actualRuntimeId = candidateActualDevice && typeof raw.actualRuntimeId === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(raw.actualRuntimeId)
    ? raw.actualRuntimeId
    : null;
  const actualRuntimeVersion = candidateActualDevice && typeof raw.actualRuntimeVersion === "string" && raw.actualRuntimeVersion.length <= 64
    ? raw.actualRuntimeVersion
    : null;
  const actualDevice = actualRuntimeId && actualRuntimeVersion ? candidateActualDevice : null;
  return {
    requestedDevice: raw.requestedDevice,
    allowCudaFallback: raw.allowCudaFallback,
    actualDevice,
    actualRuntimeId: actualDevice ? actualRuntimeId : null,
    actualRuntimeVersion: actualDevice ? actualRuntimeVersion : null,
    fallbackReason,
    detection: {
      cpu: safeDetection(raw.detection?.cpu, "cpu"),
      cuda: safeDetection(raw.detection?.cuda, "cuda"),
    },
    updatedAt: typeof raw.updatedAt === "string" && raw.updatedAt.length <= 64 ? raw.updatedAt : null,
  };
}

function runtimeStatus(capability, device, engineId = "whisper.cpp") {
  if (engineId === "qwen3-asr") {
    return capability?.optionalRuntimes?.find((runtime) => runtime.device === "cuda" && runtime.engineId === engineId);
  }
  return device === "cpu"
    ? capability?.runtime
    : capability?.optionalRuntimes?.find((runtime) => runtime.device === "cuda" && (!runtime.engineId || runtime.engineId === engineId));
}

function detectionFromCapability(state, capability, device, engineId = "whisper.cpp") {
  const runtime = runtimeStatus(capability, device, engineId);
  if (!runtime || runtime.installState !== "ready") {
    return {
      status: "unavailable",
      runtimeId: runtime?.id ?? (device === "cpu" ? "whisper-cpp-cpu-x64" : "whisper-cpp-cuda-12.4-x64"),
      runtimeVersion: runtime?.version ?? capability?.engineVersion ?? "1.9.1",
      reason: "runtime_not_ready",
    };
  }
  const persisted = state.detection[device];
  if (persisted?.runtimeId === runtime.id && persisted.runtimeVersion === runtime.version) return persisted;
  return {
    status: "not_detected",
    runtimeId: runtime.id,
    runtimeVersion: runtime.version,
  };
}

function validateResolvedRuntime(runtime, device, engineId = "whisper.cpp") {
  if (
    !runtime ||
    runtime.engineId !== engineId ||
    (engineId === "whisper.cpp" ? runtime.engineVersion !== "1.9.1" : runtime.engineVersion !== "0.0.6") ||
    runtime.device !== device ||
    typeof runtime.runtimeId !== "string" ||
    typeof runtime.runtimeVersion !== "string"
  ) {
    throw fail("INVALID_ARTIFACT", "Verified ASR runtime is invalid");
  }
  return runtime;
}

function fallbackFromCudaDetection(detection) {
  if (detection?.reason === "initialization_failed") return "cuda_initialization_failed";
  if (detection?.reason === "probe_failed") return "cuda_probe_failed";
  return "cuda_not_ready";
}

export function createAsrDeviceSelector({
  getCapabilityStatus,
  resolveRuntime,
  resolveProbeRuntime = resolveRuntime,
  probeRuntime,
  cancelProbe = () => ({ cancelled: false }),
  getDefaultModelId = () => "small",
  loadState = () => null,
  saveState = () => {},
  now = () => new Date().toISOString(),
}) {
  if (
    typeof getCapabilityStatus !== "function" ||
    typeof resolveRuntime !== "function" ||
    typeof resolveProbeRuntime !== "function" ||
    typeof probeRuntime !== "function" ||
    typeof cancelProbe !== "function" ||
    typeof getDefaultModelId !== "function" ||
    typeof loadState !== "function" ||
    typeof saveState !== "function" ||
    typeof now !== "function"
  ) {
    throw fail("INVALID_INPUT", "ASR device selector dependencies are invalid");
  }
  const activeDetections = new Map();

  async function readState() {
    return normalizeState(await loadState());
  }

  async function persist(state) {
    const value = { ...state, updatedAt: now() };
    await saveState(value);
    return value;
  }

  function selectedModelId() {
    const value = getDefaultModelId();
    return isAsrModelId(value) ? value : "small";
  }

  function publicStatus(state, capability) {
    const cudaEngineId = asrEngineForModelId(selectedModelId());
    return {
      requestedDevice: state.requestedDevice,
      allowCudaFallback: state.allowCudaFallback,
      actualDevice: state.actualDevice,
      actualRuntimeId: state.actualRuntimeId,
      actualRuntimeVersion: state.actualRuntimeVersion,
      fallbackReason: state.fallbackReason,
      detection: {
        cpu: detectionFromCapability(state, capability, "cpu"),
        cuda: detectionFromCapability(state, capability, "cuda", cudaEngineId),
      },
      updatedAt: state.updatedAt,
    };
  }

  async function getStatus() {
    const [state, capability] = await Promise.all([readState(), getCapabilityStatus()]);
    return publicStatus(state, capability);
  }

  async function setPreference(request) {
    const preference = validatePreference(request);
    const [state, capability] = await Promise.all([readState(), getCapabilityStatus()]);
    const saved = await persist({ ...state, ...preference });
    return publicStatus(saved, capability);
  }

  async function detect({ operationId }) {
    safeOperationId(operationId);
    if (activeDetections.has(operationId)) throw fail("CONFLICT", "Device detection is already active", true);
    const token = { cancelled: false };
    activeDetections.set(operationId, token);
    try {
      const [capability, state] = await Promise.all([getCapabilityStatus(), readState()]);
      const modelId = selectedModelId();
      const cudaEngineId = asrEngineForModelId(modelId);
      const detection = {};
      for (const device of ["cpu", "cuda"]) {
        if (token.cancelled) throw fail("CANCELLED", "ASR device detection was cancelled", true);
        const engineId = device === "cuda" ? cudaEngineId : "whisper.cpp";
        const installed = runtimeStatus(capability, device, engineId);
        if (!installed || installed.installState !== "ready") {
          detection[device] = detectionFromCapability(state, capability, device, engineId);
          continue;
        }
        const selectedRuntime = validateResolvedRuntime(
          await resolveProbeRuntime(device, device === "cuda" ? modelId : "small"),
          device,
          engineId,
        );
        try {
          const result = await probeRuntime({ operationId, device, runtime: selectedRuntime });
          if (token.cancelled) throw fail("CANCELLED", "ASR device detection was cancelled", true);
          detection[device] = result?.available === true
            ? {
                status: "available",
                runtimeId: selectedRuntime.runtimeId,
                runtimeVersion: selectedRuntime.runtimeVersion,
              }
            : {
                status: "unavailable",
                runtimeId: selectedRuntime.runtimeId,
                runtimeVersion: selectedRuntime.runtimeVersion,
                reason: "probe_failed",
              };
        } catch (error) {
          if (error?.code === "CANCELLED" || token.cancelled) {
            throw fail("CANCELLED", "ASR device detection was cancelled", true);
          }
          detection[device] = {
            status: "unavailable",
            runtimeId: selectedRuntime.runtimeId,
            runtimeVersion: selectedRuntime.runtimeVersion,
            reason: error?.code === "CUDA_INITIALIZATION_FAILED" ? "initialization_failed" : "probe_failed",
          };
        }
      }
      if (token.cancelled) throw fail("CANCELLED", "ASR device detection was cancelled", true);
      const saved = await persist({ ...state, detection });
      return publicStatus(saved, capability);
    } finally {
      activeDetections.delete(operationId);
    }
  }

  async function cancel({ operationId }) {
    safeOperationId(operationId);
    const token = activeDetections.get(operationId);
    if (!token) return { cancelled: false };
    token.cancelled = true;
    await cancelProbe({ operationId });
    return { cancelled: true };
  }

  async function run({ operationId, modelId = "small", requestedDevice, allowCudaFallback, executeStagedAttempt }) {
    safeOperationId(operationId);
    if (!isAsrModelId(modelId)) throw fail("INVALID_INPUT", "ASR modelId is invalid");
    const preference = validatePreference({ requestedDevice, allowCudaFallback });
    if (typeof executeStagedAttempt !== "function") {
      throw fail("INVALID_INPUT", "executeStagedAttempt is required");
    }
    const [capability, previous] = await Promise.all([getCapabilityStatus(), readState()]);
    const state = { ...previous, ...preference };
    const engineId = asrEngineForModelId(modelId);
    const qwen = engineId === "qwen3-asr";
    const engineRuntime = runtimeStatus(capability, qwen ? "cuda" : "cpu", engineId);
    if (engineRuntime?.installState !== "ready") {
      throw fail("NOT_AVAILABLE", "Verified CPU ASR runtime is not ready", true);
    }
    if (qwen && requestedDevice === "cpu") throw fail("CUDA_UNAVAILABLE", "Qwen3-ASR Preview requires CUDA", true);
    const cudaReady = runtimeStatus(capability, "cuda", engineId)?.installState === "ready";
    const cudaDetection = qwen ? { status: "not_detected" } : detectionFromCapability(state, capability, "cuda");
    let selectedDevice;
    let fallbackReason = null;
    if (requestedDevice === "cpu") {
      selectedDevice = "cpu";
    } else if (requestedDevice === "cuda") {
      if (cudaReady) selectedDevice = "cuda";
      else if (allowCudaFallback && !qwen) {
        selectedDevice = "cpu";
        fallbackReason = "cuda_not_ready";
      } else {
        await persist({ ...state, actualDevice: null, actualRuntimeId: null, actualRuntimeVersion: null, fallbackReason: "cuda_not_ready" });
        throw fail("CUDA_UNAVAILABLE", "CUDA ASR runtime is not available", true);
      }
    } else if (cudaReady && cudaDetection.status !== "unavailable") {
      selectedDevice = "cuda";
    } else {
      if (qwen) throw fail("CUDA_UNAVAILABLE", "Qwen3-ASR Preview requires CUDA", true);
      selectedDevice = "cpu";
      fallbackReason = fallbackFromCudaDetection(cudaDetection);
    }

    async function attempt(device) {
      const selectedRuntime = validateResolvedRuntime(await resolveRuntime(device, modelId), device, engineId);
      const result = await executeStagedAttempt({ device, runtime: selectedRuntime });
      return { result, runtime: selectedRuntime };
    }

    try {
      const completed = await attempt(selectedDevice);
      const saved = await persist({
        ...state,
        actualDevice: selectedDevice,
        actualRuntimeId: completed.runtime.runtimeId,
        actualRuntimeVersion: completed.runtime.runtimeVersion,
        fallbackReason,
      });
      return {
        result: completed.result,
        requestedDevice,
        actualDevice: selectedDevice,
        runtimeId: completed.runtime.runtimeId,
        runtimeVersion: completed.runtime.runtimeVersion,
        fallbackReason: saved.fallbackReason,
      };
    } catch (error) {
      if (selectedDevice !== "cuda" || error?.code !== "CUDA_INITIALIZATION_FAILED") throw error;
      const failedState = {
        ...state,
        detection: {
          ...state.detection,
          cuda: {
            status: "unavailable",
            runtimeId: runtimeStatus(capability, "cuda", engineId).id,
            runtimeVersion: runtimeStatus(capability, "cuda", engineId).version,
            reason: "initialization_failed",
          },
        },
        actualDevice: null,
        actualRuntimeId: null,
        actualRuntimeVersion: null,
        fallbackReason: "cuda_initialization_failed",
      };
      if (qwen || (requestedDevice !== "auto" && !allowCudaFallback)) {
        await persist(failedState);
        throw fail("CUDA_UNAVAILABLE", "CUDA initialization failed", true);
      }
      const completed = await attempt("cpu");
      await persist({
        ...failedState,
        actualDevice: "cpu",
        actualRuntimeId: completed.runtime.runtimeId,
        actualRuntimeVersion: completed.runtime.runtimeVersion,
      });
      return {
        result: completed.result,
        requestedDevice,
        actualDevice: "cpu",
        runtimeId: completed.runtime.runtimeId,
        runtimeVersion: completed.runtime.runtimeVersion,
        fallbackReason: "cuda_initialization_failed",
      };
    }
  }

  return { getStatus, setPreference, detect, cancel, run };
}

export const ASR_DEVICE_VALUES = Object.freeze(["auto", "cpu", "cuda"]);
