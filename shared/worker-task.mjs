export const WORKER_TASK_STATUSES = Object.freeze([
  "pending",
  "running",
  "pausing",
  "paused",
  "cancelling",
  "cancelled",
  "failed",
  "recoverable",
  "completed",
]);

export const WORKER_TASK_STAGES = Object.freeze([
  "detect",
  "extract",
  "asr",
  "segment",
  "translate",
  "qa",
  "export",
]);

export const LEGAL_TRANSITIONS = Object.freeze({
  pending: Object.freeze(["running", "paused", "cancelling", "recoverable"]),
  running: Object.freeze(["pausing", "cancelling", "failed", "recoverable", "completed"]),
  pausing: Object.freeze(["paused", "failed", "recoverable", "cancelling"]),
  paused: Object.freeze(["running", "cancelling"]),
  cancelling: Object.freeze(["cancelled", "failed"]),
  cancelled: Object.freeze([]),
  failed: Object.freeze(["recoverable"]),
  recoverable: Object.freeze(["running", "cancelling"]),
  completed: Object.freeze([]),
});

export function isLegalTransition(from, to) {
  return LEGAL_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isWorkerEventSequenceAccepted(previousSequence, incomingSequence) {
  return Number.isSafeInteger(incomingSequence)
    && incomingSequence >= 0
    && (previousSequence === undefined || incomingSequence > previousSequence);
}
