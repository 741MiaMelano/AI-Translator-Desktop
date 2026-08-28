import type { Segment, TargetTextLayers, TargetTrack } from "../src/domain/workspace";

export function createCandidateTargetTrack(options: {
  sourceTrack: { targetTracks: TargetTrack[] };
  languageCode: string;
  idFactory: () => string;
}): { ok: true; candidateTrack: TargetTrack; candidateTexts: Record<string, TargetTextLayers> };

export function fillCandidateTexts(
  candidateTexts: Record<string, TargetTextLayers>,
  translations: Record<string, string>,
): { ok: true; candidateTexts: Record<string, TargetTextLayers> };

export function adoptCandidateSegment(options: {
  segments: Segment[];
  languageCode: string;
  segmentId: string;
  candidateTexts: Record<string, TargetTextLayers>;
  force?: boolean;
}):
  | { ok: true; segments: Segment[]; provenance: Record<string, string> }
  | { ok: false; reason: string; segments: Segment[] };
