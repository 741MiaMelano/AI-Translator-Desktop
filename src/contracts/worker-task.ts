// src/contracts/worker-task.ts
// Phase 1 contract definition only. No runtime implementation.
// Worker task state machine and event protocol (T04 + T05).

import {
  LEGAL_TRANSITIONS as runtimeLegalTransitions,
  isLegalTransition as runtimeIsLegalTransition,
  isWorkerEventSequenceAccepted as runtimeIsWorkerEventSequenceAccepted,
} from '../../shared/worker-task.mjs';

// -----------------------------------------------------------------------------
// Core task lifecycle states (Phase 2+)
// -----------------------------------------------------------------------------
export type WorkerTaskStatus =
  | 'pending'
  | 'running'
  | 'pausing'
  | 'paused'
  | 'cancelling'
  | 'cancelled'
  | 'failed'
  | 'recoverable'
  | 'completed';

// -----------------------------------------------------------------------------
// Stages align with domain TaskStage but are explicit here for protocol.
// -----------------------------------------------------------------------------
export type WorkerTaskStage =
  | 'detect'
  | 'extract'
  | 'asr'
  | 'segment'
  | 'translate'
  | 'qa'
  | 'export';

// -----------------------------------------------------------------------------
// Immutable snapshot id for a run (or partial rerun)
// -----------------------------------------------------------------------------
export type RunSnapshotId = string;
export type WorkerTaskKind = 'media' | 'asr' | 'translate' | 'qa' | 'export';

// -----------------------------------------------------------------------------
// Task identity
// -----------------------------------------------------------------------------
export interface WorkerTaskId {
  taskId: string;
  projectId: string;
  // For per-language translation sub-tasks
  targetLanguageCode?: string;
}

// -----------------------------------------------------------------------------
// Task record (stored in app DB queue + project history)
// -----------------------------------------------------------------------------
export interface WorkerTaskRecord extends WorkerTaskId {
  kind: WorkerTaskKind;
  label: string;
  detail: string;
  stage: WorkerTaskStage;
  status: WorkerTaskStatus;
  progress: number; // 0-100
  createdAt: string; // ISO
  updatedAt: string; // ISO
  checkpointStage?: WorkerTaskStage; // last successfully completed stage
  lastErrorCode?: string; // sanitized
  retryable?: boolean;
  runSnapshotId?: RunSnapshotId; // current or last used
  sequence: number;
  attempt: number;
  pauseCapability: 'never' | 'checkpoint';
}

// -----------------------------------------------------------------------------
// State machine transitions (legal only)
// From -> To (allowed)
// -----------------------------------------------------------------------------
export const LEGAL_TRANSITIONS = runtimeLegalTransitions as Record<
  WorkerTaskStatus,
  readonly WorkerTaskStatus[]
>;

export function isLegalTransition(from: WorkerTaskStatus, to: WorkerTaskStatus): boolean {
  return runtimeIsLegalTransition(from, to);
}

export function isWorkerEventSequenceAccepted(
  previousSequence: number | undefined,
  incomingSequence: number,
): boolean {
  return runtimeIsWorkerEventSequenceAccepted(previousSequence, incomingSequence);
}

// -----------------------------------------------------------------------------
// Checkpoint rule
// - On entering 'completed' for a stage, checkpointStage is advanced.
// - Restart after crash/hard kill resumes from checkpointStage (or start).
// - Restart NEVER auto-starts work; user must confirm.
// -----------------------------------------------------------------------------
export interface Checkpoint {
  taskId: string;
  projectId: string;
  lastSuccessfulStage?: WorkerTaskStage;
  lastSuccessfulAt?: string;
}

// -----------------------------------------------------------------------------
// Events (one-way from supervisor to renderer via main)
// All events carry strictly increasing sequence per task.
// -----------------------------------------------------------------------------
export interface WorkerEventBase {
  taskId: string;
  projectId: string;
  stage: WorkerTaskStage; // stage at which the event occurred
  sequence: number; // monotonic per task
  timestamp: string; // ISO
}

export interface WorkerProgressEvent extends WorkerEventBase {
  type: 'progress';
  progress: number; // 0-100
  targetLanguageCode?: string;
  message?: string; // sanitized, no secrets/paths
}

export interface WorkerStatusEvent extends WorkerEventBase {
  type: 'status';
  status: WorkerTaskStatus;
  progress?: number;
  reason?: string; // sanitized
  checkpointStage?: WorkerTaskStage;
  errorCode?: string;
}

export interface WorkerLogEvent extends WorkerEventBase {
  type: 'log';
  level: 'info' | 'warn' | 'error';
  message: string; // sanitized
}

export type WorkerEvent =
  | WorkerProgressEvent
  | WorkerStatusEvent
  | WorkerLogEvent;

// -----------------------------------------------------------------------------
// Control commands (renderer -> main -> supervisor)
// -----------------------------------------------------------------------------
export interface WorkerControlCommand {
  taskId: string;
  projectId: string;
  action: 'pause' | 'resume' | 'cancel' | 'retry';
}

// -----------------------------------------------------------------------------
// Recovery semantics
// - After process/app crash: tasks that were 'running' become 'recoverable'.
// - User explicitly chooses to resume; resume starts from last checkpoint.
// - No automatic re-execution of paid stages.
// -----------------------------------------------------------------------------
export interface RecoveryPlan {
  taskId: string;
  projectId: string;
  resumeFromStage: WorkerTaskStage;
  requiresUserConfirmation: true;
}

// -----------------------------------------------------------------------------
// Validation / invariants (enforced at main/supervisor boundary)
// - isWorkerEventSequenceAccepted is the SSOT: duplicates or out-of-order events are dropped.
// - status transitions must be legal per LEGAL_TRANSITIONS.
// - progress is clamped 0-100; backtracking progress is allowed only on retry.
// - No secrets, absolute host paths, or raw stack traces in events to renderer.
// -----------------------------------------------------------------------------
