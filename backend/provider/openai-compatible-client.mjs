import { joinProviderUrl, normalizeProviderBaseUrl } from "./base-url.mjs";
import { classifyHttpStatus, createProviderError } from "./errors.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function isDeepSeekOfficial(baseUrl) {
  let host = "";
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    // requestJson owns the canonical URL validation and error classification.
  }
  return host === "api.deepseek.com";
}

function structuredResponseFormat(baseUrl, schema) {
  // ponytail: DeepSeek official only accepts json_object; make this user-configurable if another endpoint needs it.
  if (isDeepSeekOfficial(baseUrl)) return { type: "json_object" };
  return {
    type: "json_schema",
    json_schema: { name: schema.name, strict: true, schema: schema.schema },
  };
}

function structuredMessages(baseUrl, messages) {
  if (!isDeepSeekOfficial(baseUrl)) return messages;
  return [{
    role: "system",
    content: 'Return JSON with exactly this shape: {"targetLanguage":"<exact requested code>","segments":[{"segmentId":"<exact input id>","text":"<translation>"}]}. Preserve every key and segmentId.',
  }, ...messages];
}

async function readResponseText(response, maxBytes) {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw createProviderError({
      providerErrorClass: "invalid_payload",
      message: "Provider response exceeded size limit",
    });
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw createProviderError({
        providerErrorClass: "invalid_payload",
        message: "Provider response exceeded size limit",
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
        message: "Provider response exceeded size limit",
      });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

/**
 * Minimal OpenAI-compatible client using Node fetch.
 * Never logs secrets; never follows redirects with Authorization.
 */
export function createOpenAICompatibleClient({
  fetchImpl = globalThis.fetch,
  allowLoopbackHttp = false,
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
} = {}) {
  async function requestJson({
    baseUrl,
    path,
    method = "POST",
    apiKey,
    body,
    timeoutMs = defaultTimeoutMs,
    signal,
    transportMode,
  }) {
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      throw createProviderError({
        providerErrorClass: "auth",
        message: "API credential is missing",
        code: "INVALID_INPUT",
      });
    }
    const normalized = normalizeProviderBaseUrl(baseUrl, { allowLoopbackHttp });
    const url = joinProviderUrl(normalized.href, path);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) {
        throw createProviderError({
          providerErrorClass: "cancelled",
          message: "Provider request cancelled",
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
          Authorization: `Bearer ${apiKey}`,
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
          message: "Provider redirect is not allowed",
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
            const classified = classifyHttpStatus(response.status);
            throw createProviderError({
              ...classified,
              httpStatus: response.status,
            });
          }
          throw createProviderError({
            providerErrorClass: "invalid_payload",
            message: "Provider returned non-JSON payload",
            httpStatus: response.status,
          });
        }
      }

      if (!response.ok) {
        const classified = classifyHttpStatus(response.status);
        throw createProviderError({
          ...classified,
          httpStatus: response.status,
        });
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
            message: "Provider request cancelled",
            code: "CANCELLED",
          });
        }
        throw createProviderError({
          providerErrorClass: "timeout",
          message: "Provider request timed out",
          retryable: true,
        });
      }
      if (String(error?.message || "").toLowerCase().includes("redirect")) {
        throw createProviderError({
          providerErrorClass: "redirect_blocked",
          message: "Provider redirect is not allowed",
        });
      }
      throw createProviderError({
        providerErrorClass: "network",
        message: "Provider network request failed",
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
    transportMode = "responses",
    model,
    timeoutMs = 15_000,
    signal,
  }) {
    const path =
      transportMode === "chat_completions" ? "/chat/completions" : "/responses";
    const body =
      transportMode === "chat_completions"
        ? {
            model: model || "gpt-4.1-mini",
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 1,
          }
        : {
            model: model || "gpt-4.1-mini",
            input: "ping",
            max_output_tokens: 1,
          };

    const result = await requestJson({
      baseUrl,
      path,
      apiKey,
      body,
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
    transportMode = "responses",
    model,
    schema,
    messages,
    temperature = 0.2,
    maxOutputTokens = 2048,
    timeoutMs = defaultTimeoutMs,
    signal,
  }) {
    if (transportMode === "chat_completions") {
      const result = await requestJson({
        baseUrl,
        path: "/chat/completions",
        apiKey,
        body: {
          model,
          temperature,
          max_tokens: maxOutputTokens,
          response_format: structuredResponseFormat(baseUrl, schema),
          ...(isDeepSeekOfficial(baseUrl) ? { thinking: { type: "disabled" } } : {}),
          messages: structuredMessages(baseUrl, messages),
        },
        timeoutMs,
        signal,
        transportMode,
      });
      const content = result.json?.choices?.[0]?.message?.content;
      return {
        rawText: typeof content === "string" ? content : null,
        usage: normalizeUsage(result.json?.usage),
        baseUrlDisplay: result.baseUrlDisplay,
        transportMode,
      };
    }

    const result = await requestJson({
      baseUrl,
      path: "/responses",
      apiKey,
      body: {
        model,
        temperature,
        max_output_tokens: maxOutputTokens,
        text: {
          format: {
            type: "json_schema",
            name: schema.name,
            strict: true,
            schema: schema.schema,
          },
        },
        input: messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      },
      timeoutMs,
      signal,
      transportMode,
    });

    const rawText = extractResponsesText(result.json);
    return {
      rawText,
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

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const input =
    numberOrNull(usage.input_tokens) ??
    numberOrNull(usage.prompt_tokens) ??
    numberOrNull(usage.inputTokens);
  const output =
    numberOrNull(usage.output_tokens) ??
    numberOrNull(usage.completion_tokens) ??
    numberOrNull(usage.outputTokens);
  if (input === null && output === null) {
    return null;
  }
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    totalTokens: (input ?? 0) + (output ?? 0),
  };
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function extractResponsesText(json) {
  if (!json || typeof json !== "object") return null;
  if (typeof json.output_text === "string") return json.output_text;
  const output = Array.isArray(json.output) ? json.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === "string") return part.text;
      if (typeof part?.output_text === "string") return part.output_text;
    }
  }
  return null;
}
