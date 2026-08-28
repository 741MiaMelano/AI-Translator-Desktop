const RESOURCE_KINDS = new Set([
  "glossary",
  "style_guide",
  "subtitle_style",
  "export_preset",
]);
const POSITIONS = new Set(["top", "center", "bottom"]);
const LAYOUTS = new Set([
  "target_only",
  "source_top_target_bottom",
  "target_top_source_bottom",
]);
const OUTPUT_CONTENT = new Set(["source", "target", "bilingual"]);
const OUTPUT_FORMATS = new Set(["srt", "vtt", "ass"]);

function invalid(message) {
  const error = new Error(message);
  error.code = "INVALID_RESOURCE";
  throw error;
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`);
  return value;
}

function string(value, label, { allowEmpty = false, max = 4_096 } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0) || value.length > max) {
    invalid(`${label} must be a${allowEmpty ? " bounded" : " non-empty"} string`);
  }
  return value;
}

function boolean(value, label) {
  if (typeof value !== "boolean") invalid(`${label} must be a boolean`);
  return value;
}

function finiteNumber(value, label, { min = 0, max = 1_000 } = {}) {
  if (!Number.isFinite(value) || value < min || value > max) invalid(`${label} is out of range`);
  return value;
}

function color(value, label) {
  const normalized = string(value, label, { max: 7 }).toUpperCase();
  if (!/^#[0-9A-F]{6}$/.test(normalized)) invalid(`${label} must be #RRGGBB`);
  return normalized;
}

function array(value, label, { max = 2_000 } = {}) {
  if (!Array.isArray(value) || value.length > max) invalid(`${label} must be an array`);
  return value;
}

function optionalStrings(value, label) {
  return array(value ?? [], label, { max: 100 }).map((item, index) =>
    string(item, `${label}[${index}]`, { max: 100 }),
  );
}

function rejectKeys(value, keys, label) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) invalid(`${label}.${key} is not allowed`);
  }
}

function glossaryPayload(value) {
  const payload = object(value, "payload");
  return {
    languagePairs: array(payload.languagePairs, "payload.languagePairs", { max: 100 }).map((pair, pairIndex) => {
      pair = object(pair, `payload.languagePairs[${pairIndex}]`);
      return {
        sourceLanguageCode: string(pair.sourceLanguageCode, `languagePairs[${pairIndex}].sourceLanguageCode`, { max: 40 }),
        targetLanguageCode: string(pair.targetLanguageCode, `languagePairs[${pairIndex}].targetLanguageCode`, { max: 40 }),
        entries: array(pair.entries, `languagePairs[${pairIndex}].entries`).map((entry, entryIndex) => {
          entry = object(entry, `entries[${entryIndex}]`);
          const normalized = {
            id: string(entry.id, `entries[${entryIndex}].id`, { max: 200 }),
            source: string(entry.source, `entries[${entryIndex}].source`, { max: 1_000 }),
            target: string(entry.target, `entries[${entryIndex}].target`, { max: 1_000 }),
            enabled: boolean(entry.enabled, `entries[${entryIndex}].enabled`),
          };
          for (const key of ["partOfSpeech", "domain", "note"]) {
            if (entry[key] !== undefined) normalized[key] = string(entry[key], `entries[${entryIndex}].${key}`, { allowEmpty: true, max: 1_000 });
          }
          if (entry.tags !== undefined) normalized.tags = optionalStrings(entry.tags, `entries[${entryIndex}].tags`);
          return normalized;
        }),
      };
    }),
  };
}

function styleGuidePayload(value) {
  const payload = object(value, "payload");
  const normalized = {
    targetLanguageCode: string(payload.targetLanguageCode, "payload.targetLanguageCode", { max: 40 }),
    tags: optionalStrings(payload.tags, "payload.tags"),
    scenes: optionalStrings(payload.scenes, "payload.scenes"),
    rules: array(payload.rules, "payload.rules", { max: 500 }).map((rule, index) => {
      rule = object(rule, `payload.rules[${index}]`);
      return {
        id: string(rule.id, `rules[${index}].id`, { max: 200 }),
        title: string(rule.title, `rules[${index}].title`, { max: 200 }),
        instruction: string(rule.instruction, `rules[${index}].instruction`, { max: 4_096 }),
        enabled: boolean(rule.enabled, `rules[${index}].enabled`),
      };
    }),
  };
  if (payload.sample !== undefined) {
    const sample = object(payload.sample, "payload.sample");
    normalized.sample = {
      sourceText: string(sample.sourceText, "payload.sample.sourceText", { allowEmpty: true }),
      targetText: string(sample.targetText, "payload.sample.targetText", { allowEmpty: true }),
      note: string(sample.note, "payload.sample.note", { allowEmpty: true }),
    };
  }
  return normalized;
}

function textStyle(value, label) {
  const style = object(value, label);
  return {
    fontFamily: string(style.fontFamily, `${label}.fontFamily`, { max: 200 }),
    fontSizePx: finiteNumber(style.fontSizePx, `${label}.fontSizePx`, { min: 1, max: 400 }),
    textColor: color(style.textColor, `${label}.textColor`),
    outlineColor: color(style.outlineColor, `${label}.outlineColor`),
    outlineWidthPx: finiteNumber(style.outlineWidthPx, `${label}.outlineWidthPx`, { max: 50 }),
    shadowColor: color(style.shadowColor, `${label}.shadowColor`),
    shadowDepthPx: finiteNumber(style.shadowDepthPx, `${label}.shadowDepthPx`, { max: 50 }),
    position: POSITIONS.has(style.position) ? style.position : invalid(`${label}.position is invalid`),
  };
}

function subtitleStylePayload(value) {
  const payload = object(value, "payload");
  rejectKeys(payload, ["outputs", "burnVideo", "fileNameTemplate", "destination", "activeTrackId"], "payload");
  if (payload.format !== "ass") invalid("payload.format must be ass");
  if (!LAYOUTS.has(payload.bilingualLayout)) invalid("payload.bilingualLayout is invalid");
  const preview = object(payload.preview, "payload.preview");
  if (!["auto", "ltr", "rtl"].includes(preview.direction)) invalid("payload.preview.direction is invalid");
  return {
    format: "ass",
    bilingualLayout: payload.bilingualLayout,
    primary: textStyle(payload.primary, "payload.primary"),
    secondary: textStyle(payload.secondary, "payload.secondary"),
    preview: {
      sourceText: string(preview.sourceText, "payload.preview.sourceText", { allowEmpty: true }),
      targetText: string(preview.targetText, "payload.preview.targetText", { allowEmpty: true }),
      direction: preview.direction,
      backgroundColor: color(preview.backgroundColor, "payload.preview.backgroundColor"),
    },
  };
}

export function normalizeSubtitleStylePayload(value) {
  return subtitleStylePayload(value);
}

function exportPresetPayload(value) {
  const payload = object(value, "payload");
  rejectKeys(payload, ["primary", "secondary", "preview", "bilingualLayout", "activeTrackId", "subtitleStyleId"], "payload");
  const destination = object(payload.destination, "payload.destination");
  let normalizedDestination;
  if (destination.kind === "project_exports") normalizedDestination = { kind: "project_exports" };
  else if (destination.kind === "custom_directory") normalizedDestination = {
    kind: "custom_directory",
    directory: string(destination.directory, "payload.destination.directory", { max: 4_096 }),
  };
  else invalid("payload.destination.kind is invalid");
  return {
    outputs: array(payload.outputs, "payload.outputs", { max: 20 }).map((output, index) => {
      output = object(output, `payload.outputs[${index}]`);
      if (!OUTPUT_CONTENT.has(output.content) || !OUTPUT_FORMATS.has(output.format)) invalid(`payload.outputs[${index}] is invalid`);
      return { content: output.content, format: output.format };
    }),
    burnVideo: boolean(payload.burnVideo, "payload.burnVideo"),
    fileNameTemplate: string(payload.fileNameTemplate, "payload.fileNameTemplate", { max: 500 }),
    destination: normalizedDestination,
  };
}

const NORMALIZE_PAYLOAD = {
  glossary: glossaryPayload,
  style_guide: styleGuidePayload,
  subtitle_style: subtitleStylePayload,
  export_preset: exportPresetPayload,
};

export function normalizeResourceWrite(value) {
  const resource = object(value, "resource");
  if (!RESOURCE_KINDS.has(resource.kind)) invalid("resource.kind is invalid");
  const id = string(resource.id, "resource.id", { max: 200 });
  if (id === "." || id === ".." || !/^[A-Za-z0-9._-]+$/.test(id)) invalid("resource.id is invalid");
  return {
    id,
    kind: resource.kind,
    name: string(resource.name, "resource.name", { max: 200 }),
    description: string(resource.description, "resource.description", { allowEmpty: true, max: 2_000 }),
    payload: NORMALIZE_PAYLOAD[resource.kind](resource.payload),
  };
}

export function normalizeProjectResourceSnapshot(value) {
  const snapshot = object(value, "snapshot");
  const resource = normalizeResourceWrite({ ...snapshot, description: "" });
  if (snapshot.scope !== "project_snapshot" || snapshot.schemaVersion !== 1) invalid("snapshot contract metadata is invalid");
  const source = object(snapshot.source, "snapshot.source");
  let normalizedSource;
  if (source.kind === "project_local") normalizedSource = { kind: "project_local" };
  else if (source.kind === "global") {
    normalizedSource = {
      kind: "global",
      resourceId: string(source.resourceId, "snapshot.source.resourceId", { max: 200 }),
      revision: Number.isSafeInteger(source.revision) && source.revision > 0
        ? source.revision
        : invalid("snapshot.source.revision is invalid"),
    };
  } else invalid("snapshot.source.kind is invalid");
  return {
    id: resource.id,
    kind: resource.kind,
    name: resource.name,
    scope: "project_snapshot",
    schemaVersion: 1,
    source: normalizedSource,
    capturedAt: string(snapshot.capturedAt, "snapshot.capturedAt", { max: 100 }),
    payload: resource.payload,
  };
}
