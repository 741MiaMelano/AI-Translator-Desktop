// Phase 1 executable evidence for the Worker task contract.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  LEGAL_TRANSITIONS,
  isLegalTransition,
  isWorkerEventSequenceAccepted,
} from './worker-task.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerSource = readFileSync(join(__dirname, 'worker-task.ts'), 'utf8');

test('uses the exported Worker state machine', () => {
  assert.ok(LEGAL_TRANSITIONS && typeof LEGAL_TRANSITIONS === 'object');
  assert.equal(isLegalTransition('pending', 'running'), true);
  assert.equal(isLegalTransition('running', 'completed'), true);
  assert.equal(isLegalTransition('failed', 'recoverable'), true);
  assert.equal(isLegalTransition('pending', 'completed'), false);
  assert.equal(isLegalTransition('completed', 'running'), false);
  assert.equal(isLegalTransition('cancelled', 'running'), false);
});

test('accepts only the first or a strictly increasing Worker event sequence', () => {
  assert.equal(isWorkerEventSequenceAccepted(undefined, 10), true);
  assert.equal(isWorkerEventSequenceAccepted(10, 11), true);
  assert.equal(isWorkerEventSequenceAccepted(10, 10), false);
  assert.equal(isWorkerEventSequenceAccepted(10, 9), false);
  assert.equal(isWorkerEventSequenceAccepted(undefined, Number.NaN), false);
  assert.equal(isWorkerEventSequenceAccepted(undefined, -1), false);
  assert.equal(isWorkerEventSequenceAccepted(undefined, 1.5), false);
});

test('WorkerEvent base requires taskId, stage, sequence, and timestamp', () => {
  const base = workerSource.slice(
    workerSource.indexOf('export interface WorkerEventBase'),
    workerSource.indexOf('export interface WorkerProgressEvent'),
  );

  for (const field of ['taskId', 'stage', 'sequence', 'timestamp']) {
    assert.match(base, new RegExp(`\\b${field}:`));
  }
});

test('recovery requires explicit user confirmation', () => {
  assert.match(workerSource, /requiresUserConfirmation:\s*true/);
});
