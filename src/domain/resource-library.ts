export const RESOURCE_CONTRACT_VERSION = 1 as const;

export type ResourceKind = "glossary" | "style_guide" | "subtitle_style" | "export_preset";

export interface GlossaryEntry {
  id: string;
  source: string;
  target: string;
  partOfSpeech?: string;
  domain?: string;
  tags?: string[];
  note?: string;
  enabled: boolean;
}

export interface GlossaryLanguagePair {
  sourceLanguageCode: string;
  targetLanguageCode: string;
  entries: GlossaryEntry[];
}

export interface GlossaryPayload {
  languagePairs: GlossaryLanguagePair[];
}

export interface StyleGuideRule {
  id: string;
  title: string;
  instruction: string;
  enabled: boolean;
}

export interface StyleGuidePayload {
  targetLanguageCode: string;
  tags: string[];
  scenes: string[];
  rules: StyleGuideRule[];
  sample?: {
    sourceText: string;
    targetText: string;
    note: string;
  };
}

export type SubtitlePosition = "top" | "center" | "bottom";
export type BilingualLayout =
  | "target_only"
  | "source_top_target_bottom"
  | "target_top_source_bottom";

export interface AssTextStyle {
  fontFamily: string;
  fontSizePx: number;
  textColor: string;
  outlineColor: string;
  outlineWidthPx: number;
  shadowColor: string;
  shadowDepthPx: number;
  position: SubtitlePosition;
}

export interface SubtitleStylePayload {
  format: "ass";
  bilingualLayout: BilingualLayout;
  primary: AssTextStyle;
  secondary: AssTextStyle;
  preview: {
    sourceText: string;
    targetText: string;
    direction: "auto" | "ltr" | "rtl";
    backgroundColor: string;
  };
}

export function createDefaultSubtitleStyle(): SubtitleStylePayload {
  return {
    format: "ass",
    bilingualLayout: "target_only",
    primary: {
      fontFamily: "Arial",
      fontSizePx: 48,
      textColor: "#FFFFFF",
      outlineColor: "#000000",
      outlineWidthPx: 2,
      shadowColor: "#000000",
      shadowDepthPx: 0,
      position: "bottom",
    },
    secondary: {
      fontFamily: "Arial",
      fontSizePx: 20,
      textColor: "#FFFFFF",
      outlineColor: "#111111",
      outlineWidthPx: 1,
      shadowColor: "#000000",
      shadowDepthPx: 1,
      position: "bottom",
    },
    preview: {
      sourceText: "This is a sample subtitle",
      targetText: "这是一条字幕样例",
      direction: "auto",
      backgroundColor: "#25211D",
    },
  };
}

export type SubtitleExportFormat = "srt" | "vtt" | "ass";
export type ExportContent = "source" | "target" | "bilingual";

export interface ExportPresetPayload {
  outputs: Array<{
    content: ExportContent;
    format: SubtitleExportFormat;
  }>;
  burnVideo: boolean;
  fileNameTemplate: string;
  destination:
    | { kind: "project_exports" }
      | { kind: "custom_directory"; directory: string };
}

export interface ResourcePayloadByKind {
  glossary: GlossaryPayload;
  style_guide: StyleGuidePayload;
  subtitle_style: SubtitleStylePayload;
  export_preset: ExportPresetPayload;
}

export interface GlobalResource<K extends ResourceKind> {
  id: string;
  kind: K;
  name: string;
  description: string;
  scope: "global";
  schemaVersion: typeof RESOURCE_CONTRACT_VERSION;
  revision: number;
  updatedAt: string;
  payload: ResourcePayloadByKind[K];
}

export type GlobalGlossary = GlobalResource<"glossary">;
export type GlobalStyleGuide = GlobalResource<"style_guide">;
export type GlobalSubtitleStyle = GlobalResource<"subtitle_style">;
export type GlobalExportPreset = GlobalResource<"export_preset">;
export type AnyGlobalResource = {
  [K in ResourceKind]: GlobalResource<K>;
}[ResourceKind];

export type ResourceWriteInput = {
  [K in ResourceKind]: Pick<GlobalResource<K>, "id" | "kind" | "name" | "description" | "payload">;
}[ResourceKind];

export interface ResourceLibrary {
  glossaries: GlobalGlossary[];
  styleGuides: GlobalStyleGuide[];
  subtitleStyles: GlobalSubtitleStyle[];
  exportPresets: GlobalExportPreset[];
}

export type ResourceSnapshotSource =
  | { kind: "global"; resourceId: string; revision: number }
  | { kind: "project_local" };

export interface ProjectResourceSnapshot<K extends ResourceKind> {
  id: string;
  kind: K;
  name: string;
  scope: "project_snapshot";
  schemaVersion: typeof RESOURCE_CONTRACT_VERSION;
  source: ResourceSnapshotSource;
  capturedAt: string;
  payload: ResourcePayloadByKind[K];
}

export type GlossarySnapshot = ProjectResourceSnapshot<"glossary">;
export type StyleGuideSnapshot = ProjectResourceSnapshot<"style_guide">;
export type SubtitleStyleSnapshot = ProjectResourceSnapshot<"subtitle_style">;
export type ExportPresetSnapshot = ProjectResourceSnapshot<"export_preset">;
export type AnyProjectResourceSnapshot = {
  [K in ResourceKind]: ProjectResourceSnapshot<K>;
}[ResourceKind];
