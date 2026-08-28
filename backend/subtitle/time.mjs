export function parseSrtTimestamp(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{2,}):(\d{2}):(\d{2}),(\d{3})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number(match[4]);
  if (minutes > 59 || seconds > 59) return null;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + milliseconds;
}

export function parseVttTimestamp(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const long = /^(\d{2,}):(\d{2}):(\d{2})\.(\d{3})$/.exec(trimmed);
  if (long) {
    const hours = Number(long[1]);
    const minutes = Number(long[2]);
    const seconds = Number(long[3]);
    const milliseconds = Number(long[4]);
    if (minutes > 59 || seconds > 59) return null;
    return ((hours * 60 + minutes) * 60 + seconds) * 1000 + milliseconds;
  }
  const short = /^(\d{2}):(\d{2})\.(\d{3})$/.exec(trimmed);
  if (!short) return null;
  const minutes = Number(short[1]);
  const seconds = Number(short[2]);
  const milliseconds = Number(short[3]);
  if (minutes > 59 || seconds > 59) return null;
  return (minutes * 60 + seconds) * 1000 + milliseconds;
}

export function parseAssTimestamp(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d+):(\d{2}):(\d{2})\.(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const centiseconds = Number(match[4]);
  if (minutes > 59 || seconds > 59) return null;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + centiseconds * 10;
}

export function formatSrtTimestamp(ms) {
  if (!Number.isInteger(ms) || ms < 0) {
    throw new Error(`Invalid millisecond timestamp: ${ms}`);
  }
  const milliseconds = ms % 1000;
  const totalSeconds = Math.floor(ms / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(milliseconds).padStart(3, "0")}`;
}

export function formatVttTimestamp(ms) {
  const srt = formatSrtTimestamp(ms);
  return srt.replace(",", ".");
}

export function formatAssTimestamp(ms) {
  if (!Number.isInteger(ms) || ms < 0) {
    throw new Error(`Invalid millisecond timestamp: ${ms}`);
  }
  const totalCentiseconds = Math.floor(ms / 10);
  const centiseconds = totalCentiseconds % 100;
  const totalSeconds = Math.floor(totalCentiseconds / 100);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
}

export function domainTimestampFromMs(ms) {
  return formatSrtTimestamp(ms);
}
