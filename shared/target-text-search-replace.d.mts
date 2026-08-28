import type { EditorHistory, EditorHistoryEntry, Segment } from "../src/domain/workspace";

export function searchReplaceTargetTexts(options: {
  segments: Segment[];
  languageCode: string;
  findText: string;
  replaceText: string;
  scopeSegmentIds?: string[] | null;
  matchField?: "target" | "source";
}): {
  ok: true;
  segments: Segment[];
  replacedCount: number;
  skippedLockedCount: number;
  changedSegmentIds: string[];
};

export function createUndoRedoStack(): {
  push(entry: EditorHistoryEntry): void;
  undo(): EditorHistoryEntry | null;
  redo(): EditorHistoryEntry | null;
  serialize(): EditorHistory;
  restore(history?: EditorHistory): void;
};
