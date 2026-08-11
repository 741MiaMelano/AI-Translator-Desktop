const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function normalizeProviderBaseUrl(rawUrl, { allowLoopbackHttp = false } = {}) {
  if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) {
    const error = new Error("base URL is required");
    error.code = "INVALID_INPUT";
    error.providerErrorClass = "invalid_config";
    throw error;
  }
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    const error = new Error("base URL is invalid");
    error.code = "INVALID_INPUT";
    error.providerErrorClass = "invalid_config";
    throw error;
  }
  if (parsed.username || parsed.password) {
    const error = new Error("base URL must not include credentials");
    error.code = "INVALID_INPUT";
    error.providerErrorClass = "invalid_config";
    throw error;
  }
  const host = parsed.hostname.toLowerCase();
  const isLoopback = LOOPBACK_HOSTS.has(host);
  if (parsed.protocol === "http:") {
    if (!(allowLoopbackHttp && isLoopback)) {
      const error = new Error("base URL must use HTTPS");
      error.code = "INVALID_INPUT";
      error.providerErrorClass = "invalid_config";
      throw error;
    }
  } else if (parsed.protocol !== "https:") {
    const error = new Error("base URL protocol is not allowed");
    error.code = "INVALID_INPUT";
    error.providerErrorClass = "invalid_config";
    throw error;
  }
  // Drop query/hash so secrets never ride on URL fragments.
  parsed.search = "";
  parsed.hash = "";
  let href = parsed.toString();
  if (href.endsWith("/")) {
    href = href.slice(0, -1);
  }
  return {
    href,
    origin: parsed.origin,
    host: parsed.host,
    display: `${parsed.protocol}//${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`,
  };
}

export function joinProviderUrl(baseHref, path) {
  const base = baseHref.endsWith("/") ? baseHref.slice(0, -1) : baseHref;
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}
