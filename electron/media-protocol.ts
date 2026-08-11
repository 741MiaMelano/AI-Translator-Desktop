import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, isAbsolute, normalize } from "node:path";

export const MEDIA_SCHEME = "app-media";

type Grant = {
  token: string;
  projectId: string;
  assetId: string;
  absolutePath: string;
  webContentsId: number;
  expiresAt: number;
  idleTtlMs: number;
  mimeType: string;
};

const grants = new Map<string, Grant>();
const DEFAULT_MEDIA_GRANT_IDLE_TTL_MS = 12 * 60 * 60 * 1_000;

const MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
};

function failResponse(status = 404) {
  return new Response(null, { status });
}

export function clearMediaGrants() {
  grants.clear();
}

export function revokeMediaGrantsForWebContents(webContentsId: number) {
  for (const [token, grant] of grants) {
    if (grant.webContentsId === webContentsId) grants.delete(token);
  }
}

export function revokeMediaGrantsForProject(projectId: string) {
  for (const [token, grant] of grants) {
    if (grant.projectId === projectId) grants.delete(token);
  }
}

export function issueMediaGrant({
  projectId,
  assetId,
  absolutePath,
  webContentsId,
  ttlMs = DEFAULT_MEDIA_GRANT_IDLE_TTL_MS,
  mimeType,
}: {
  projectId: string;
  assetId: string;
  absolutePath: string;
  webContentsId: number;
  ttlMs?: number;
  mimeType?: string;
}) {
  if (!isAbsolute(absolutePath) || !existsSync(absolutePath)) {
    throw Object.assign(new Error("Media file unavailable"), { code: "NOT_FOUND" });
  }
  const token = randomBytes(24).toString("hex");
  const ext = extname(absolutePath).toLowerCase();
  const grant: Grant = {
    token,
    projectId,
    assetId,
    absolutePath: normalize(absolutePath),
    webContentsId,
    expiresAt: Date.now() + ttlMs,
    idleTtlMs: ttlMs,
    mimeType: mimeType || MIME_BY_EXT[ext] || "application/octet-stream",
  };
  grants.set(token, grant);
  return {
    url: `${MEDIA_SCHEME}://asset/${token}`,
    expiresAt: grant.expiresAt,
  };
}

function parseTokenFromUrl(urlString: string): string | null {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return null;
  }
  if (url.protocol !== `${MEDIA_SCHEME}:`) return null;
  if (url.hostname !== "asset") return null;
  if (url.username || url.password) return null;
  if (url.search) return null;
  const parts = url.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
  if (parts.length !== 1) return null;
  const token = parts[0];
  if (!/^[a-f0-9]{32,128}$/i.test(token)) return null;
  if (token.includes("..") || token.includes("%") || token.includes("\\")) return null;
  return token;
}

function getGrant(token: string, webContentsId?: number) {
  const grant = grants.get(token);
  if (!grant) return null;
  const now = Date.now();
  if (now > grant.expiresAt) {
    grants.delete(token);
    return null;
  }
  if (webContentsId != null && grant.webContentsId !== webContentsId) return null;
  if (!existsSync(grant.absolutePath)) {
    grants.delete(token);
    return null;
  }
  // Media elements issue fresh Range requests throughout playback and after every seek.
  // Keep an actively used, renderer-bound grant alive instead of invalidating long edits
  // after the original fixed timeout.
  grant.expiresAt = now + grant.idleTtlMs;
  return grant;
}

export function isMediaGrantAuthorized(urlString: string, webContentsId?: number) {
  const token = parseTokenFromUrl(urlString);
  return Boolean(token && Number.isInteger(webContentsId) && getGrant(token, webContentsId));
}

function parseRange(header: string | null, size: number) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match) return "invalid";
  if (header.includes(",")) return "invalid";
  const startText = match[1];
  const endText = match[2];
  if (!startText && !endText) return "invalid";
  let start = startText ? Number(startText) : 0;
  let end = endText ? Number(endText) : size - 1;
  if (!startText && endText) {
    const suffix = Number(endText);
    if (!Number.isInteger(suffix) || suffix <= 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
    return "invalid";
  }
  end = Math.min(end, size - 1);
  return { start, end };
}

export async function handleMediaProtocolRequest(
  request: Request,
  options: { webContentsId?: number } = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return failResponse(405);
  }
  const token = parseTokenFromUrl(request.url);
  if (!token) return failResponse(400);
  const grant = getGrant(token, options.webContentsId);
  if (!grant) return failResponse(403);

  const st = statSync(grant.absolutePath);
  if (!st.isFile()) return failResponse(404);
  const size = st.size;
  const rangeHeader = request.headers.get("range");
  const range = parseRange(rangeHeader, size);
  if (range === "invalid") {
    return new Response(null, {
      status: 416,
      headers: {
        "Content-Range": `bytes */${size}`,
        "Accept-Ranges": "bytes",
      },
    });
  }

  const headers = new Headers({
    "Content-Type": grant.mimeType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  });

  if (!range) {
    headers.set("Content-Length", String(size));
    if (method === "HEAD") return new Response(null, { status: 200, headers });
    const stream = createReadStream(grant.absolutePath);
    return new Response(stream as any, { status: 200, headers });
  }

  const { start, end } = range;
  const chunkSize = end - start + 1;
  headers.set("Content-Length", String(chunkSize));
  headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  if (method === "HEAD") return new Response(null, { status: 206, headers });
  const stream = createReadStream(grant.absolutePath, { start, end });
  return new Response(stream as any, { status: 206, headers });
}

export function mediaProtocolPrivilegedScheme() {
  return {
    scheme: MEDIA_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: false,
      corsEnabled: false,
    },
  };
}

export function grantCountForTests() {
  return grants.size;
}
