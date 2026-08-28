import type { Segment } from "../src/domain/workspace";

export function planSelectedSegmentRerun(options: {
  segments: Segment[];
  selectedSegmentIds: string[];
  languageCode: string;
}):
  | {
      ok: true;
      requestSegmentIds: string[];
      contextSegmentIds: string[];
      skippedLockedSegmentIds: string[];
      requestSegments: Segment[];
      contextSegments: Array<Segment & { readOnly: true }>;
      coverage: { mode: "selected_segments"; segmentIds: string[] };
    }
  | { ok: false; reason: string };

export function applySelectedSegmentRerunResult(options: {
  segments: Segment[];
  languageCode: string;
  translations: Record<string, string>;
  allowedSegmentIds: string[];
}):
  | { ok: true; segments: Segment[]; appliedSegmentIds: string[]; changedCount: number }
  | { ok: false; reason: string; segments: Segment[] };
