export const WORKER_TASK_STATUSES: readonly string[];
export const WORKER_TASK_STAGES: readonly string[];
export const LEGAL_TRANSITIONS: Readonly<Record<string, readonly string[]>>;
export function isLegalTransition(from: string, to: string): boolean;
export function isWorkerEventSequenceAccepted(
  previousSequence: number | undefined,
  incomingSequence: number,
): boolean;
