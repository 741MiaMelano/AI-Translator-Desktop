const STREAM_COUNT_MAX = 256;
const STRING_FIELD_MAX_CODE_POINTS = 512;

const MEDIA_ERROR_CODES = Object.freeze({
  INVALID_INPUT: "INVALID_INPUT",
  CORRUPT_INPUT: "CORRUPT_INPUT",
  OUTPUT_TOO_LARGE: "OUTPUT_TOO_LARGE",
});

const MEDIA_KINDS = new Set(["video", "audio", "subtitle", "unknown"]);
const STREAM_KINDS = new Set(["video", "audio", "subtitle", "data", "unknown"]);

const BITMAP_SUBTITLE_CODECS = new Set([
  "hdmv_pgs_subtitle",
  "pgs",
  "dvd_subtitle",
  "dvdsub",
  "dvb_subtitle",
  "dvb_teletext",
  "xsub",
]);

const TEXT_SUBTITLE_CODECS = new Set([
  "subrip",
  "srt",
  "ass",
  "ssa",
  "webvtt",
  "mov_text",
  "ttml",
  "text",
]);

function fail(message, code = MEDIA_ERROR_CODES.INVALID_INPUT) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function clipCodePoints(value, max = STRING_FIELD_MAX_CODE_POINTS) {
  if (value == null) return null;
  const text = String(value).normalize("NFC").trim();
  if (!text) return null;
  const chars = Array.from(text);
  return chars.slice(0, max).join("");
}

export function isExtractableTextSubtitleCodec(codec) {
  if (!codec) return false;
  const normalized = String(codec).toLowerCase();
  if (BITMAP_SUBTITLE_CODECS.has(normalized)) return false;
  return TEXT_SUBTITLE_CODECS.has(normalized);
}

export function classifyMediaKind(streams) {
  const list = Array.isArray(streams) ? streams : [];
  if (list.some((s) => s.kind === "video")) return "video";
  if (list.some((s) => s.kind === "audio")) return "audio";
  if (list.some((s) => s.kind === "subtitle")) return "subtitle";
  return "unknown";
}

function normalizeLanguage(raw) {
  if (raw == null) return null;
  const text = clipCodePoints(raw, 32);
  if (!text) return null;
  const lower = text.toLowerCase();
  if (lower === "und" || lower === "unknown" || lower === "null") return null;
  return lower;
}

function finiteInt(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER, optional = false } = {}) {
  if (value == null || value === "") {
    if (optional) return null;
    throw fail(`missing ${field}`);
  }
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    throw fail(`invalid ${field}`);
  }
  return n;
}

function finiteNumber(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER, optional = false } = {}) {
  if (value == null || value === "") {
    if (optional) return null;
    throw fail(`missing ${field}`);
  }
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw fail(`invalid ${field}`);
  }
  return n;
}

function mapCodecType(codecType) {
  const t = String(codecType || "").toLowerCase();
  if (t === "video" || t === "audio" || t === "subtitle" || t === "data") return t;
  return "unknown";
}

/**
 * Normalize raw ffprobe-like JSON into the bounded MediaProbe contract.
 * Does not keep arbitrary tags or original JSON.
 */
export function normalizeMediaProbe(raw, options = {}) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw fail("probe payload must be an object", MEDIA_ERROR_CODES.CORRUPT_INPUT);
  }
  const format = raw.format && typeof raw.format === "object" && !Array.isArray(raw.format) ? raw.format : {};
  const streamsIn = Array.isArray(raw.streams) ? raw.streams : null;
  if (!streamsIn) {
    throw fail("probe streams must be an array", MEDIA_ERROR_CODES.CORRUPT_INPUT);
  }
  if (streamsIn.length > STREAM_COUNT_MAX) {
    throw fail("too many streams", MEDIA_ERROR_CODES.OUTPUT_TOO_LARGE);
  }

  const warnings = [];
  const streams = [];
  for (let i = 0; i < streamsIn.length; i += 1) {
    const item = streamsIn[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw fail("invalid stream entry", MEDIA_ERROR_CODES.CORRUPT_INPUT);
    }
    const index = finiteInt(item.index ?? i, `streams[${i}].index`, { min: 0, max: 4096 });
    const kind = mapCodecType(item.codec_type ?? item.kind);
    if (!STREAM_KINDS.has(kind)) {
      throw fail("invalid stream kind", MEDIA_ERROR_CODES.CORRUPT_INPUT);
    }
    const codec = clipCodePoints(item.codec_name ?? item.codec, 64);
    const disposition =
      item.disposition && typeof item.disposition === "object" && !Array.isArray(item.disposition)
        ? item.disposition
        : {};
    const tags = item.tags && typeof item.tags === "object" && !Array.isArray(item.tags) ? item.tags : {};
    const language = normalizeLanguage(item.language ?? tags.language);
    if ((kind === "audio" || kind === "subtitle") && language == null) {
      warnings.push({ code: "UNKNOWN_LANGUAGE", streamIndex: index });
    }
    const title = clipCodePoints(item.title ?? tags.title, 128);
    const isDefault = Boolean(disposition.default === 1 || disposition.default === true || item.default);
    const isForced = Boolean(disposition.forced === 1 || disposition.forced === true || item.forced);
    const extractable =
      kind === "subtitle" ? isExtractableTextSubtitleCodec(codec) : false;
    if (kind === "subtitle" && codec && !extractable) {
      warnings.push({ code: "UNSUPPORTED_SUBTITLE_CODEC", streamIndex: index, codec });
    }

    const stream = {
      streamId: `s:${index}`,
      index,
      kind,
      codec,
      language,
      title,
      default: isDefault,
      forced: isForced,
      extractable,
      width: kind === "video" ? finiteInt(item.width, "width", { min: 0, max: 16384, optional: true }) : null,
      height: kind === "video" ? finiteInt(item.height, "height", { min: 0, max: 16384, optional: true }) : null,
      channels: kind === "audio" ? finiteInt(item.channels, "channels", { min: 0, max: 64, optional: true }) : null,
      sampleRate:
        kind === "audio"
          ? finiteInt(item.sample_rate ?? item.sampleRate, "sampleRate", { min: 0, max: 1_000_000, optional: true })
          : null,
    };
    streams.push(stream);
  }

  let durationMs = null;
  if (format.duration != null && format.duration !== "") {
    const seconds = finiteNumber(format.duration, "duration", { min: 0, max: 86400 * 365, optional: true });
    if (seconds == null) {
      warnings.push({ code: "MISSING_DURATION" });
    } else {
      durationMs = Math.round(seconds * 1000);
    }
  } else {
    warnings.push({ code: "MISSING_DURATION" });
  }

  const sizeBytes = finiteInt(format.size ?? format.sizeBytes, "size", {
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    optional: true,
  });

  const mediaKind = classifyMediaKind(streams);
  if (!MEDIA_KINDS.has(mediaKind)) {
    throw fail("invalid mediaKind");
  }

  return {
    mediaKind,
    format: {
      formatName: clipCodePoints(format.format_name ?? format.formatName, 128),
      durationMs,
      sizeBytes,
    },
    streams,
    warnings,
    probeVersion: 1,
    artifact: {
      upstreamVersion: clipCodePoints(options.upstreamVersion ?? null, 64),
      ffprobeSha256: clipCodePoints(options.ffprobeSha256 ?? null, 64),
    },
  };
}

export function validateMediaProbe(probe) {
  if (!probe || typeof probe !== "object" || Array.isArray(probe)) {
    throw fail("MediaProbe must be an object");
  }
  if (!MEDIA_KINDS.has(probe.mediaKind)) throw fail("invalid mediaKind");
  if (!probe.format || typeof probe.format !== "object") throw fail("missing format");
  if (!Array.isArray(probe.streams) || probe.streams.length > STREAM_COUNT_MAX) {
    throw fail("invalid streams");
  }
  if (probe.probeVersion !== 1) throw fail("unsupported probeVersion");
  for (const stream of probe.streams) {
    if (!stream || typeof stream !== "object") throw fail("invalid stream");
    if (typeof stream.streamId !== "string" || !stream.streamId.startsWith("s:")) {
      throw fail("invalid streamId");
    }
    if (!STREAM_KINDS.has(stream.kind)) throw fail("invalid stream kind");
    if ("raw" in stream || "tags" in stream) throw fail("raw probe fields are not allowed");
  }
  if (JSON.stringify(probe).includes("codec_type")) {
    throw fail("raw ffprobe fields are not allowed");
  }
  return probe;
}

export {
  BITMAP_SUBTITLE_CODECS,
  TEXT_SUBTITLE_CODECS,
  MEDIA_KINDS,
  STREAM_KINDS,
};
