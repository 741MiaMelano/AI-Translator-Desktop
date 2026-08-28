import { joinProviderUrl, normalizeProviderBaseUrl } from "./base-url.mjs";
import { classifyHttpStatus, createProviderError } from "./errors.mjs";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_MAX_MODELS = 500;
const MAX_MODEL_ID_CHARS = 200;
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_PAGE_LIMIT = 100;

/** Discovery styles supported today; every OpenAI-compatible vendor uses "bearer". */
export const MODEL_LIST_STYLES = Object.freeze(["bearer", "anthropic"]);

/** Providers with no listable catalog endpoint. */
const NO_MODEL_LIST_PROFILES = new Set(["deepl"]);

const BASE_URL_MESSAGES = new Map([
  ["base URL is required", "请先填写服务地址"],
  ["base URL is invalid", "服务地址格式无效"],
  ["base URL must not include credentials", "服务地址不能包含账号或密码"],
  ["base URL must use HTTPS", "服务地址必须使用 HTTPS"],
  ["base URL protocol is not allowed", "服务地址使用了不被允许的协议"],
]);

const MESSAGE_BY_ERROR_CLASS = Object.freeze({
  auth: "鉴权失败，请检查 API 密钥是否正确",
  rate_limit: "服务商限流，请稍后重试",
  timeout: "获取模型列表超时，请稍后重试",
  cancelled: "已取消获取模型列表",
  network: "网络请求失败，请检查网络或服务地址",
  server: "服务商暂时不可用，请稍后重试",
  invalid_payload: "服务商返回的模型列表无法解析",
  invalid_config: "服务地址或参数无效",
  schema_mismatch: "服务商返回的模型列表无法解析",
  redirect_blocked: "服务地址发生跳转，已出于安全考虑阻止",
  unknown: "获取模型列表失败",
});

/**
 * Chinese copy for anything the user can see. Locally raised errors are already
 * localized, so keep them; worker-relayed errors lose their message and are
 * rebuilt from the classification instead.
 */
export function describeModelListError(providerErrorClass, message) {
  if (typeof message === "string" && /[一-鿿]/.test(message)) return message;
  return MESSAGE_BY_ERROR_CLASS[providerErrorClass] ?? MESSAGE_BY_ERROR_CLASS.unknown;
}

/**
 * Picks the discovery style for a provider-registry entry. Registry entries may
 * pin it explicitly via `modelListStyle` (use `null` to opt out); otherwise the
 * profile decides, defaulting to the OpenAI-compatible `GET /models`.
 */
export function resolveModelListStyle(definition) {
  const explicit = definition?.modelListStyle;
  if (explicit === null || MODEL_LIST_STYLES.includes(explicit)) return explicit;
  const profile = String(definition?.profile ?? "");
  if (NO_MODEL_LIST_PROFILES.has(profile)) return null;
  if (profile.includes("anthropic")) return "anthropic";
  return "bearer";
}

/** Same validation as every other provider call, with localized messages. */
export function normalizeModelListBaseUrl(baseUrl, { allowLoopbackHttp = false } = {}) {
  try {
    return normalizeProviderBaseUrl(baseUrl, { allowLoopbackHttp });
  } catch (error) {
    throw createProviderError({
      providerErrorClass: error?.providerErrorClass ?? "invalid_config",
      message: BASE_URL_MESSAGES.get(error?.message) ?? "服务地址无效",
      code: "INVALID_INPUT",
    });
  }
}

function modelListPath(style, normalized) {
  if (style !== "anthropic") return "/models";
  // Anthropic documents {baseUrl}/v1/models; tolerate a base that already ends in /v1.
  const versioned = /\/v1$/.test(new URL(normalized.href).pathname);
  return `${versioned ? "" : "/v1"}/models?limit=${ANTHROPIC_PAGE_LIMIT}`;
}

function modelListHeaders(style, apiKey) {
  if (style === "anthropic") {
    return {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      Accept: "application/json",
    };
  }
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };
}

async function readResponseText(response, maxBytes) {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw createProviderError({
      providerErrorClass: "invalid_payload",
      message: "模型列表响应超过大小上限",
    });
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw createProviderError({
        providerErrorClass: "invalid_payload",
        message: "模型列表响应超过大小上限",
      });
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw createProviderError({
        providerErrorClass: "invalid_payload",
        message: "模型列表响应超过大小上限",
      });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

function httpError(status) {
  const classified = classifyHttpStatus(status);
  return createProviderError({
    ...classified,
    message: describeModelListError(classified.providerErrorClass),
    httpStatus: status,
  });
}

function entryId(entry) {
  if (typeof entry === "string") return entry;
  if (typeof entry?.id === "string") return entry.id;
  if (typeof entry?.name === "string") return entry.name;
  return null;
}

function entryLabel(entry, id) {
  const label = entry?.display_name ?? entry?.displayName;
  return typeof label === "string" && label.length > 0 && label.length <= MAX_MODEL_ID_CHARS
    ? label
    : id;
}

function extractModels(json, maxModels) {
  const rows = Array.isArray(json?.data)
    ? json.data
    : Array.isArray(json?.models)
      ? json.models
      : null;
  if (!rows) {
    throw createProviderError({
      providerErrorClass: "invalid_payload",
      message: "服务商返回的模型列表无法解析",
    });
  }
  const models = [];
  const seen = new Set();
  let truncated = json?.has_more === true;
  for (const row of rows) {
    const id = entryId(row);
    if (typeof id !== "string" || id.length === 0 || id.length > MAX_MODEL_ID_CHARS) continue;
    if (seen.has(id)) continue;
    if (models.length >= maxModels) {
      truncated = true;
      break;
    }
    seen.add(id);
    models.push({ id, label: entryLabel(row, id) });
  }
  return { models, truncated };
}

/**
 * Fetches a provider's model catalog. Never logs secrets, never follows
 * redirects with credentials attached, and always bounds time and body size.
 */
export function createProviderModelsClient({
  fetchImpl = globalThis.fetch,
  allowLoopbackHttp = false,
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  maxModels = DEFAULT_MAX_MODELS,
} = {}) {
  async function listModels({ baseUrl, apiKey, style = "bearer", timeoutMs = defaultTimeoutMs, signal }) {
    if (!MODEL_LIST_STYLES.includes(style)) {
      throw createProviderError({
        providerErrorClass: "invalid_config",
        message: "该服务商不支持自动获取模型列表",
        code: "INVALID_INPUT",
      });
    }
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      throw createProviderError({
        providerErrorClass: "auth",
        message: "缺少 API 密钥，请先保存凭据",
        code: "INVALID_INPUT",
      });
    }
    const normalized = normalizeModelListBaseUrl(baseUrl, { allowLoopbackHttp });
    const url = joinProviderUrl(normalized.href, modelListPath(style, normalized));
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) {
        throw createProviderError({
          providerErrorClass: "cancelled",
          message: "已取消获取模型列表",
          code: "CANCELLED",
        });
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: modelListHeaders(style, apiKey),
        signal: controller.signal,
        redirect: "error",
      });

      if (
        response.type === "opaqueredirect" ||
        response.status === 301 ||
        response.status === 302 ||
        response.status === 307 ||
        response.status === 308
      ) {
        throw createProviderError({
          providerErrorClass: "redirect_blocked",
          message: "服务地址发生跳转，已出于安全考虑阻止",
          httpStatus: response.status,
        });
      }

      const text = await readResponseText(response, maxResponseBytes);
      if (!response.ok) {
        throw httpError(response.status);
      }
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        throw createProviderError({
          providerErrorClass: "invalid_payload",
          message: "服务商返回了非 JSON 响应",
          httpStatus: response.status,
        });
      }

      const { models, truncated } = extractModels(json, maxModels);
      return {
        models,
        truncated,
        style,
        baseUrlDisplay: normalized.display,
      };
    } catch (error) {
      if (error?.providerErrorClass) throw error;
      if (error?.name === "AbortError") {
        if (signal?.aborted) {
          throw createProviderError({
            providerErrorClass: "cancelled",
            message: "已取消获取模型列表",
            code: "CANCELLED",
          });
        }
        throw createProviderError({
          providerErrorClass: "timeout",
          message: "获取模型列表超时，请稍后重试",
          retryable: true,
        });
      }
      if (String(error?.message || "").toLowerCase().includes("redirect")) {
        throw createProviderError({
          providerErrorClass: "redirect_blocked",
          message: "服务地址发生跳转，已出于安全考虑阻止",
        });
      }
      throw createProviderError({
        providerErrorClass: "network",
        message: "网络请求失败，请检查网络或服务地址",
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  return { listModels };
}
