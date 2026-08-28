function durationMatches(media, subtitle) {
  const mediaMs = media.probe?.format?.durationMs;
  const subtitleMs = subtitle.probe?.format?.durationMs;
  if (!Number.isFinite(mediaMs) || !Number.isFinite(subtitleMs)) return false;

  // ponytail: duration-only matching is conservative; add content fingerprints if real batches collide often.
  return Math.abs(mediaMs - subtitleMs) <= Math.max(2_000, mediaMs * 0.01);
}

export function planBatchGroups(files) {
  const mainMedia = files.filter(({ probe }) => probe?.mediaKind === "video" || probe?.mediaKind === "audio");
  const subtitles = files.filter(({ probe }) => probe?.mediaKind === "subtitle");
  const subtitlesByMedia = new Map(mainMedia.map((file) => [file.id, []]));
  const ambiguities = [];

  for (const subtitle of subtitles) {
    const matches = mainMedia.filter((media) => durationMatches(media, subtitle));
    if (matches.length === 1) subtitlesByMedia.get(matches[0].id).push(subtitle);
    if (matches.length > 1) {
      ambiguities.push({
        kind: "media_match",
        fileId: subtitle.id,
        candidateMediaFileIds: matches.map(({ id }) => id),
      });
    }
  }

  const groupedSubtitleIds = new Set(
    [...subtitlesByMedia.values()].flat().map(({ id }) => id),
  );
  const groups = [];
  for (const file of files) {
    if (file.probe?.mediaKind === "video" || file.probe?.mediaKind === "audio") {
      const matchedSubtitles = subtitlesByMedia.get(file.id);
      if (matchedSubtitles.length > 0) {
        groups.push({ confidence: "high", fileIds: [file.id, ...matchedSubtitles.map(({ id }) => id)] });
      } else {
        groups.push({ confidence: "low", fileIds: [file.id] });
      }
    } else if (!groupedSubtitleIds.has(file.id)) {
      groups.push({ confidence: "low", fileIds: [file.id] });
    }
  }
  return { groups, ambiguities };
}

export function suggestBatchGroups(files) {
  return planBatchGroups(files).groups;
}
