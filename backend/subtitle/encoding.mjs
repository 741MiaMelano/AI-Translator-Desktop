const UTF8_BOM = [0xef, 0xbb, 0xbf];
const UTF16LE_BOM = [0xff, 0xfe];
const UTF16BE_BOM = [0xfe, 0xff];

function startsWith(bytes, signature) {
  if (bytes.length < signature.length) return false;
  return signature.every((value, index) => bytes[index] === value);
}

function isStrictUtf8(bytes) {
  let index = 0;
  while (index < bytes.length) {
    const byte = bytes[index];
    if (byte <= 0x7f) {
      index += 1;
      continue;
    }
    let size = 0;
    if ((byte & 0xe0) === 0xc0) size = 2;
    else if ((byte & 0xf0) === 0xe0) size = 3;
    else if ((byte & 0xf8) === 0xf0) size = 4;
    else return false;
    if (index + size > bytes.length) return false;
    for (let offset = 1; offset < size; offset += 1) {
      if ((bytes[index + offset] & 0xc0) !== 0x80) return false;
    }
    if (size === 2 && byte < 0xc2) return false;
    if (size === 3) {
      const next = bytes[index + 1];
      if (byte === 0xe0 && next < 0xa0) return false;
      if (byte === 0xed && next >= 0xa0) return false;
    }
    if (size === 4) {
      const next = bytes[index + 1];
      if (byte === 0xf0 && next < 0x90) return false;
      if (byte === 0xf4 && next >= 0x90) return false;
      if (byte > 0xf4) return false;
    }
    index += size;
  }
  return true;
}

function looksLikeUtf16Le(bytes) {
  if (bytes.length < 4 || bytes.length % 2 !== 0) return false;
  let asciiPairs = 0;
  let samples = 0;
  for (let index = 0; index + 1 < Math.min(bytes.length, 64); index += 2) {
    samples += 1;
    if (bytes[index + 1] === 0x00 && bytes[index] >= 0x20 && bytes[index] < 0x7f) {
      asciiPairs += 1;
    }
  }
  return samples > 0 && asciiPairs / samples >= 0.6;
}

function looksLikeUtf16Be(bytes) {
  if (bytes.length < 4 || bytes.length % 2 !== 0) return false;
  let asciiPairs = 0;
  let samples = 0;
  for (let index = 0; index + 1 < Math.min(bytes.length, 64); index += 2) {
    samples += 1;
    if (bytes[index] === 0x00 && bytes[index + 1] >= 0x20 && bytes[index + 1] < 0x7f) {
      asciiPairs += 1;
    }
  }
  return samples > 0 && asciiPairs / samples >= 0.6;
}

function decodeWithLabel(bytes, label) {
  try {
    const decoder = new TextDecoder(label, { fatal: true });
    return { ok: true, text: decoder.decode(bytes) };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: `Unable to decode subtitle as ${label}`,
        details: { encoding: label, reason: error instanceof Error ? error.message : String(error) },
      },
    };
  }
}

function detectNewline(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const cr = (text.match(/\r(?!\n)/g) || []).length;
  const lf = (text.match(/(?<!\r)\n/g) || []).length;
  const kinds = [
    crlf > 0 ? "crlf" : null,
    cr > 0 ? "cr" : null,
    lf > 0 ? "lf" : null,
  ].filter(Boolean);
  if (kinds.length === 0) return "unknown";
  if (kinds.length > 1) return "mixed";
  return kinds[0];
}

export function toUint8Array(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (Array.isArray(bytes)) return Uint8Array.from(bytes);
  throw new Error("bytes must be binary data");
}

export function decodeSubtitleBytes(inputBytes, forcedEncoding) {
  const bytes = toUint8Array(inputBytes);
  if (bytes.byteLength === 0) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "Subtitle file is empty",
      },
    };
  }

  if (forcedEncoding) {
    const decoded = decodeWithLabel(bytes, forcedEncoding === "utf-8" ? "utf-8" : forcedEncoding);
    if (!decoded.ok) return decoded;
    return {
      ok: true,
      encoding: forcedEncoding,
      text: decoded.text.replace(/^\uFEFF/, ""),
      newline: detectNewline(decoded.text),
      bom: startsWith(bytes, UTF8_BOM) || startsWith(bytes, UTF16LE_BOM) || startsWith(bytes, UTF16BE_BOM),
    };
  }

  if (startsWith(bytes, UTF8_BOM)) {
    const decoded = decodeWithLabel(bytes.subarray(3), "utf-8");
    if (!decoded.ok) return decoded;
    return {
      ok: true,
      encoding: "utf-8",
      text: decoded.text,
      newline: detectNewline(decoded.text),
      bom: true,
    };
  }

  if (startsWith(bytes, UTF16LE_BOM)) {
    const decoded = decodeWithLabel(bytes, "utf-16le");
    if (!decoded.ok) return decoded;
    return {
      ok: true,
      encoding: "utf-16le",
      text: decoded.text.replace(/^\uFEFF/, ""),
      newline: detectNewline(decoded.text),
      bom: true,
    };
  }

  if (startsWith(bytes, UTF16BE_BOM)) {
    const decoded = decodeWithLabel(bytes, "utf-16be");
    if (!decoded.ok) return decoded;
    return {
      ok: true,
      encoding: "utf-16be",
      text: decoded.text.replace(/^\uFEFF/, ""),
      newline: detectNewline(decoded.text),
      bom: true,
    };
  }

  if (isStrictUtf8(bytes)) {
    const decoded = decodeWithLabel(bytes, "utf-8");
    if (!decoded.ok) return decoded;
    return {
      ok: true,
      encoding: "utf-8",
      text: decoded.text,
      newline: detectNewline(decoded.text),
      bom: false,
    };
  }

  if (looksLikeUtf16Le(bytes)) {
    const decoded = decodeWithLabel(bytes, "utf-16le");
    if (!decoded.ok) return decoded;
    return {
      ok: true,
      encoding: "utf-16le",
      text: decoded.text.replace(/^\uFEFF/, ""),
      newline: detectNewline(decoded.text),
      bom: false,
    };
  }

  if (looksLikeUtf16Be(bytes)) {
    const decoded = decodeWithLabel(bytes, "utf-16be");
    if (!decoded.ok) return decoded;
    return {
      ok: true,
      encoding: "utf-16be",
      text: decoded.text.replace(/^\uFEFF/, ""),
      newline: detectNewline(decoded.text),
      bom: false,
    };
  }

  const gbk = decodeWithLabel(bytes, "gbk");
  const shiftJis = decodeWithLabel(bytes, "shift_jis");
  if (gbk.ok && shiftJis.ok) {
    return {
      ok: false,
      needsEncodingConfirmation: true,
      encodingCandidates: ["gbk", "shift_jis"],
      error: {
        code: "INVALID_INPUT",
        message: "Encoding needs confirmation between GBK and Shift-JIS",
        details: { encodingCandidates: ["gbk", "shift_jis"] },
      },
    };
  }
  if (gbk.ok) {
    return {
      ok: true,
      encoding: "gbk",
      text: gbk.text,
      newline: detectNewline(gbk.text),
      bom: false,
    };
  }
  if (shiftJis.ok) {
    return {
      ok: true,
      encoding: "shift_jis",
      text: shiftJis.text,
      newline: detectNewline(shiftJis.text),
      bom: false,
    };
  }

  return {
    ok: false,
    error: {
      code: "INVALID_INPUT",
      message: "Unable to decode subtitle text encoding",
    },
  };
}
