/**
 * Deterministic audio/subtitle stream recommendation (pure function).
 * reason codes are stable; UI maps them to Chinese copy separately.
 */

function languageMatches(streamLang, preferred) {
  if (!preferred) return false;
  if (streamLang == null || streamLang === "und") return false;
  return String(streamLang).toLowerCase() === String(preferred).toLowerCase();
}

function scoreSubtitle(stream, { preferredSourceLanguage, savedSubtitleStreamId }) {
  if (stream.kind !== "subtitle") return null;
  const reasons = [];
  let score = 0;
  if (savedSubtitleStreamId && stream.streamId === savedSubtitleStreamId) {
    score += 1000;
    reasons.push("USER_SAVED_SELECTION");
  }
  if (stream.extractable) {
    score += 100;
    reasons.push("EXTRACTABLE_TEXT");
  } else {
    reasons.push("BITMAP_OR_UNSUPPORTED");
  }
  if (stream.default) {
    score += 20;
    reasons.push("DEFAULT_DISPOSITION");
  }
  if (languageMatches(stream.language, preferredSourceLanguage)) {
    score += 40;
    reasons.push("SOURCE_LANGUAGE_MATCH");
  } else if (stream.language == null) {
    reasons.push("UNKNOWN_LANGUAGE");
  }
  return { stream, score, reasons };
}

function scoreAudio(stream, { preferredSourceLanguage, savedAudioStreamId }) {
  if (stream.kind !== "audio") return null;
  const reasons = [];
  let score = 0;
  if (savedAudioStreamId && stream.streamId === savedAudioStreamId) {
    score += 1000;
    reasons.push("USER_SAVED_SELECTION");
  }
  if (stream.default) {
    score += 20;
    reasons.push("DEFAULT_DISPOSITION");
  }
  if (languageMatches(stream.language, preferredSourceLanguage)) {
    score += 40;
    reasons.push("SOURCE_LANGUAGE_MATCH");
  } else if (stream.language == null) {
    reasons.push("UNKNOWN_LANGUAGE");
  }
  return { stream, score, reasons };
}

function pickBest(scored, { requireExtractable = false } = {}) {
  const eligible = scored
    .filter(Boolean)
    .filter((item) => (requireExtractable ? item.stream.extractable : true))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.stream.index - b.stream.index;
    });
  if (eligible.length === 0) {
    return {
      streamId: null,
      confidence: "none",
      requiresConfirmation: false,
      reasonCodes: ["NO_CANDIDATE"],
      tiedStreamIds: [],
    };
  }
  const best = eligible[0];
  const tied = eligible.filter((item) => item.score === best.score);
  const userSaved = best.reasons.includes("USER_SAVED_SELECTION");
  if (tied.length > 1 && !userSaved) {
    return {
      streamId: best.stream.streamId,
      confidence: "low",
      requiresConfirmation: true,
      reasonCodes: [...best.reasons, "TIE_BREAK_BY_INDEX"],
      tiedStreamIds: tied.map((item) => item.stream.streamId),
    };
  }
  return {
    streamId: best.stream.streamId,
    confidence: userSaved ? "high" : best.score >= 140 ? "high" : best.score >= 100 ? "medium" : "low",
    requiresConfirmation: !userSaved && best.score < 140,
    reasonCodes: best.reasons,
    tiedStreamIds: [],
  };
}

/**
 * @param {object} probe bounded MediaProbe
 * @param {object} options
 */
export function recommendStreams(probe, options = {}) {
  const streams = Array.isArray(probe?.streams) ? [...probe.streams] : [];

  const preferredSourceLanguage = options.preferredSourceLanguage ?? null;
  const savedAudioStreamId = options.savedAudioStreamId ?? null;
  const savedSubtitleStreamId = options.savedSubtitleStreamId ?? null;

  const warnings = [];
  if (savedSubtitleStreamId && !streams.some((s) => s.streamId === savedSubtitleStreamId && s.kind === "subtitle")) {
    warnings.push({ code: "SAVED_SUBTITLE_INVALID", streamId: savedSubtitleStreamId });
  }
  if (savedAudioStreamId && !streams.some((s) => s.streamId === savedAudioStreamId && s.kind === "audio")) {
    warnings.push({ code: "SAVED_AUDIO_INVALID", streamId: savedAudioStreamId });
  }

  const effectiveSavedSub =
    savedSubtitleStreamId && streams.some((s) => s.streamId === savedSubtitleStreamId) ? savedSubtitleStreamId : null;
  const effectiveSavedAudio =
    savedAudioStreamId && streams.some((s) => s.streamId === savedAudioStreamId) ? savedAudioStreamId : null;

  const subtitle = pickBest(
    streams.map((stream) =>
      scoreSubtitle(stream, {
        preferredSourceLanguage,
        savedSubtitleStreamId: effectiveSavedSub,
      }),
    ),
    { requireExtractable: true },
  );

  const audio = pickBest(
    streams.map((stream) =>
      scoreAudio(stream, {
        preferredSourceLanguage,
        savedAudioStreamId: effectiveSavedAudio,
      }),
    ),
  );

  return {
    subtitle,
    audio,
    warnings,
    autoStartAsr: false,
  };
}
