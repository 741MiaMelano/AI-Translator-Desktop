import { joinProviderUrl, normalizeProviderBaseUrl } from "./base-url.mjs";
import { classifyHttpStatus, createProviderError } from "./errors.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_TEST_MODEL = "claude-opus-5";
const DEFAULT_TRANSPORT_MODE = "messages";
// Anthropic 必须显式给 max_tokens；下限留出思考块的余量，上限避免请求被拒。
const MIN_MAX_TOKENS = 1024;
const MAX_MAX_TOKENS = 64_000;
// 连接测试只验证凭据与可达性，给一个极小但不为 1 的上限，避免思考模型直接报错。
const TEST_MAX_TOKENS = 16;

/**
 * 结构化输出策略：Anthropic 没有 response_format。
 * 这里不用 tools + tool_choice，而是在 system 里约束 JSON 形状后本地解析，理由是：
 * 强制 tool_choice 与「扩展思考」在部分 Claude 模型上互斥，而是否开启思考随模型默认值不同；
 * 只发 {model, max_tokens, system, messages} 是所有 Claude 模型都接受的最小请求体，
 * 不会因为附加参数（temperature / thinking / tool_choice）在某些模型上被判 400。
 * 响应侧仍然兼容 tool_use 块，模型若自行返回工具调用也能取到结构化结果。
 */
const STRUCTURED_JSON_INSTRUCTION = [
  'Return only a single JSON object with exactly this shape: {"targetLanguage":"<exact requested code>","segments":[{"segmentId":"<exact input id>","text":"<translation>"}]}.',
  "Preserve every key and every segmentId exactly as given.",
  "Do not wrap the JSON in markdown fences and do not add any commentary before or after it.",
].join(" ");

function structuredInstruction(schema) {
  if (!schema?.schema || typeof schema.schema !== "object") return STRUCTURED_JSON_INSTRUCTION;
  return `${STRUCTURED_JSON_INSTRUCTION} The object must validate against this JSON Schema: ${JSON.stringify(schema.schema)}.`;
}

// 供应商报错文案统一走简体中文，且不携带任何凭据内容。
const HTTP_ERROR_MESSAGES = Object.freeze({
  auth: "Anthropic 认证失败：API Key 无效或无权访问",
  rate_limit: "Anthropic 触发限流，请稍后重试",
  server: "Anthropic 服务端错误，请稍后重试",
  invalid_payload: "Anthropic 拒绝了本次请求",
  unknown: "Anthropic 请求失败",
});

function anthropicHttpError(status) {
  const classified = classifyHttpStatus(status);
  return createProviderError({
    providerErrorClass: classified.providerErrorClass,
    message: HTTP_ERROR_MESSAGES[classified.providerErrorClass] ?? HTTP_ERROR_MESSAGES.unknown,
    retryable: classified.retryable,
    httpStatus: status,
  });
}

/** 兼容 baseUrl 写成 https://api.anthropic.com 或 .../v1 两种配置。 */
function anthropicMessagesPath(baseUrl) {
  let pathname = "";
  try {
    pathname = new URL(String(baseUrl ?? "").trim()).pathname;
  } catch {
    // requestJson 拥有唯一的 base URL 校验与错误归类入口。
  }
  return /\/v1\/?$/.test(pathname) ? "/messages" : "/v1/messages";
}

async function readResponseText(response, maxBytes) {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw createProviderError({
      providerErrorClass: "invalid_payload",
      message: "Anthropic 响应超出体积上限",
    });
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw createProviderError({
        providerErrorClass: "invalid_payload",
        message: "Anthropic 响应超出体积上限",
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
        message: "Anthropic 响应超出体积上限",
      });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

/**
 * Anthropic Messages API 客户端，接口形状与 createOpenAICompatibleClient 保持一致。
 * 永不记录凭据；不跟随重定向。
 */
export function createAnthropicClient({
  fetchImpl = globalThis.fetch,
  allowLoopbackHttp = false,
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  anthropicVersion = ANTHROPIC_VERSION,
} = {}) {
  async function requestJson({
    baseUrl,
    path,
    method = "POST",
    apiKey,
    body,
    timeoutMs = defaultTimeoutMs,
    signal,
    transportMode = DEFAULT_TRANSPORT_MODE,
  }) {
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      throw createProviderError({
        providerErrorClass: "auth",
        message: "缺少 API 凭据",
        code: "INVALID_INPUT",
      });
    }
    const normalized = normalizeProviderBaseUrl(baseUrl, { allowLoopbackHttp });
    const url = joinProviderUrl(normalized.href, path ?? anthropicMessagesPath(normalized.href));
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) {
        throw createProviderError({
          providerErrorClass: "cancelled",
          message: "Anthropic 请求已取消",
          code: "CANCELLED",
        });
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method,
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": anthropicVersion,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        redirect: "error",
      });

      if (response.type === "opaqueredirect" || response.status === 301 || response.status === 302 || response.status === 307 || response.status === 308) {
        throw createProviderError({
          providerErrorClass: "redirect_blocked",
          message: "Anthropic 重定向已被拒绝",
          httpStatus: response.status,
        });
      }

      const text = await readResponseText(response, maxResponseBytes);
      let json = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          if (!response.ok) {
            throw anthropicHttpError(response.status);
          }
          throw createProviderError({
            providerErrorClass: "invalid_payload",
            message: "Anthropic 返回了非 JSON 内容",
            httpStatus: response.status,
          });
        }
      }

      if (!response.ok) {
        throw anthropicHttpError(response.status);
      }

      return {
        json,
        transportMode,
        baseUrlDisplay: normalized.display,
        httpStatus: response.status,
      };
    } catch (error) {
      if (error?.providerErrorClass) {
        throw error;
      }
      if (error?.name === "AbortError") {
        if (signal?.aborted) {
          throw createProviderError({
            providerErrorClass: "cancelled",
            message: "Anthropic 请求已取消",
            code: "CANCELLED",
          });
        }
        throw createProviderError({
          providerErrorClass: "timeout",
          message: "Anthropic 请求超时",
          retryable: true,
        });
      }
      if (String(error?.message || "").toLowerCase().includes("redirect")) {
        throw createProviderError({
          providerErrorClass: "redirect_blocked",
          message: "Anthropic 重定向已被拒绝",
        });
      }
      throw createProviderError({
        providerErrorClass: "network",
        message: "Anthropic 网络请求失败",
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
    }
  }

  async function testConnection({
    baseUrl,
    apiKey,
    transportMode = DEFAULT_TRANSPORT_MODE,
    model,
    timeoutMs = 15_000,
    signal,
  }) {
    const result = await requestJson({
      baseUrl,
      apiKey,
      body: {
        model: model || DEFAULT_TEST_MODEL,
        max_tokens: TEST_MAX_TOKENS,
        messages: [{ role: "user", content: "ping" }],
      },
      timeoutMs,
      signal,
      transportMode,
    });
    return {
      ok: true,
      transportMode,
      baseUrlDisplay: result.baseUrlDisplay,
      model: model || null,
    };
  }

  async function createStructuredTranslation({
    baseUrl,
    apiKey,
    transportMode = DEFAULT_TRANSPORT_MODE,
    model,
    schema,
    messages,
    // temperature 由调用方传入但不会下发：当前 Claude 模型对采样参数返回 400。
    temperature,
    maxOutputTokens = 2048,
    timeoutMs = defaultTimeoutMs,
    signal,
  }) {
    void temperature;
    const prompt = toAnthropicPrompt(messages, structuredInstruction(schema));
    const result = await requestJson({
      baseUrl,
      apiKey,
      body: {
        model,
        max_tokens: clampMaxTokens(maxOutputTokens),
        system: prompt.system,
        messages: prompt.messages,
      },
      timeoutMs,
      signal,
      transportMode,
    });

    return {
      rawText: extractStructuredText(result.json),
      usage: normalizeUsage(result.json?.usage),
      baseUrlDisplay: result.baseUrlDisplay,
      transportMode,
    };
  }

  return {
    testConnection,
    createStructuredTranslation,
    requestJson,
  };
}

function clampMaxTokens(value) {
  const requested = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : MIN_MAX_TOKENS;
  return Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, requested));
}

/**
 * OpenAI 风格的 messages 转 Anthropic 请求体：
 * system 提到顶层，其余只保留 user/assistant 且合并相邻同角色消息。
 */
function toAnthropicPrompt(messages, instruction = STRUCTURED_JSON_INSTRUCTION) {
  const list = Array.isArray(messages) ? messages : [];
  const systemParts = [];
  const chat = [];
  for (const message of list) {
    const content = messageText(message?.content);
    if (content.length === 0) continue;
    if (message?.role === "system") {
      systemParts.push(content);
      continue;
    }
    const role = message?.role === "assistant" ? "assistant" : "user";
    const last = chat[chat.length - 1];
    if (last && last.role === role) last.content = `${last.content}\n\n${content}`;
    else chat.push({ role, content });
  }
  if (chat.length === 0 || chat[0].role !== "user") {
    throw createProviderError({
      providerErrorClass: "invalid_payload",
      message: "Anthropic 请求必须以用户消息开头",
      code: "INVALID_INPUT",
    });
  }
  // 结构化约束放在最后，避免被上游 system 文案覆盖。
  systemParts.push(instruction);
  return { system: systemParts.join("\n\n"), messages: chat };
}

function messageText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** content 是块数组：优先取 tool_use 的结构化入参，否则拼接 text 块。 */
function extractStructuredText(json) {
  const content = Array.isArray(json?.content) ? json.content : null;
  if (!content) {
    throw createProviderError({
      providerErrorClass: "schema_mismatch",
      message: "Anthropic 响应结构不符合 Messages API 约定",
    });
  }
  const texts = [];
  for (const block of content) {
    if (block?.type === "tool_use" && block.input && typeof block.input === "object") {
      return JSON.stringify(block.input);
    }
    if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
  }
  if (texts.length === 0) {
    throw createProviderError({
      providerErrorClass: "schema_mismatch",
      message: "Anthropic 响应缺少可解析的文本内容",
    });
  }
  return extractJsonPayload(texts.join(""));
}

/** 去掉可能的 markdown 围栏并截取首个配对的 JSON 对象；失败时原样返回交给上层校验。 */
function extractJsonPayload(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const body = fenced ? fenced[1].trim() : trimmed;
  const start = body.indexOf("{");
  if (start === -1) return body;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < body.length; index += 1) {
    const char = body[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return body.slice(start, index + 1);
    }
  }
  return body;
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const input = numberOrNull(usage.input_tokens);
  const cacheWrite = numberOrNull(usage.cache_creation_input_tokens);
  const cacheRead = numberOrNull(usage.cache_read_input_tokens);
  const output = numberOrNull(usage.output_tokens);
  if (input === null && output === null && cacheWrite === null && cacheRead === null) {
    return null;
  }
  const inputTokens = (input ?? 0) + (cacheWrite ?? 0) + (cacheRead ?? 0);
  const outputTokens = output ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
