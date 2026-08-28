export type MediaKind = "video" | "audio" | "subtitle" | "unknown";
export type StreamKind = "video" | "audio" | "subtitle" | "data" | "unknown";

export interface MediaProbeStream {
  streamId: string;
  index: number;
  kind: StreamKind;
  codec: string | null;
  language: string | null;
  title: string | null;
  default: boolean;
  forced: boolean;
  extractable: boolean;
  width: number | null;
  height: number | null;
  channels: number | null;
  sampleRate: number | null;
}

export interface MediaProbe {
  mediaKind: MediaKind;
  format: {
    formatName: string | null;
    durationMs: number | null;
    sizeBytes: number | null;
  };
  streams: MediaProbeStream[];
  warnings: Array<Record<string, unknown>>;
  probeVersion: 1;
  artifact: {
    upstreamVersion: string | null;
    ffprobeSha256: string | null;
  };
}

export function clipCodePoints(value: unknown, max?: number): string | null;
export function isExtractableTextSubtitleCodec(codec: string | null | undefined): boolean;
export function classifyMediaKind(streams: Array<{ kind: string }>): MediaKind;
export function normalizeMediaProbe(raw: unknown, options?: Record<string, unknown>): MediaProbe;
export function validateMediaProbe(probe: unknown): MediaProbe;
