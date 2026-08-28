export const PROVIDER_ERROR_CLASSES = Object.freeze([
  "auth",
  "rate_limit",
  "timeout",
  "cancelled",
  "network",
  "server",
  "invalid_payload",
  "invalid_config",
  "schema_mismatch",
  "redirect_blocked",
  "unknown",
]);

export function createProviderError({
  providerErrorClass = "unknown",
  message,
  httpStatus = null,
  retryable = false,
  code = "INTERNAL",
}) {
  const error = new Error(message);
  error.code = code;
  error.providerErrorClass = providerErrorClass;
  error.httpStatus = httpStatus;
  error.retryable = retryable;
  return error;
}

export function classifyHttpStatus(status) {
  if (status === 401 || status === 403) {
    return { providerErrorClass: "auth", message: "Provider authentication failed", retryable: false };
  }
  if (status === 429) {
    return { providerErrorClass: "rate_limit", message: "Provider rate limit exceeded", retryable: true };
  }
  if (status >= 500) {
    return { providerErrorClass: "server", message: "Provider server error", retryable: true };
  }
  if (status >= 400) {
    return {
      providerErrorClass: "invalid_payload",
      message: "Provider rejected the request",
      retryable: false,
    };
  }
  return { providerErrorClass: "unknown", message: "Provider request failed", retryable: false };
}

export function toSafeProviderError(error) {
  const providerErrorClass =
    error?.providerErrorClass && PROVIDER_ERROR_CLASSES.includes(error.providerErrorClass)
      ? error.providerErrorClass
      : "unknown";
  const message =
    typeof error?.message === "string" && error.message.length > 0
      ? sanitizeProviderMessage(error.message)
      : "Provider request failed";
  return {
    code: error?.code === "CANCELLED" ? "CANCELLED" : error?.code === "INVALID_INPUT" ? "INVALID_INPUT" : "INTERNAL",
    message,
    details: {
      providerErrorClass,
      httpStatus: typeof error?.httpStatus === "number" ? error.httpStatus : null,
      retryable: Boolean(error?.retryable),
    },
  };
}

function sanitizeProviderMessage(message) {
  return message
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/api[_-]?key["']?\s*[:=]\s*["']?[^"'\\s]+/gi, "api_key=[redacted]")
    .replace(/[A-Za-z]:\\[^\s]+/g, "[path]")
    .replace(/\/(?:Users|home)\/[^\s]+/g, "[path]");
}
