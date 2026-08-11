// Phase 1 executable evidence for the renderer-visible Desktop API contract.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load source text for static checks
const apiSrc = readFileSync(join(__dirname, 'desktop-api.ts'), 'utf8');

// 1) Renderer-visible types must NOT expose containerPath
test('CreateProjectResponse must not expose containerPath to renderer', () => {
  assert.match(apiSrc, /CreateProjectResponse/);
  assert.doesNotMatch(apiSrc, /containerPath:\s*string/);
  assert.match(apiSrc, /containerPath is intentionally NOT exposed/);
});

test('ProjectIndexSummary must not expose containerPath to renderer', () => {
  assert.match(apiSrc, /ProjectIndexSummary/);
  assert.doesNotMatch(apiSrc, /containerPath:\s*string/);
  assert.match(apiSrc, /containerPath is intentionally NOT exposed/);
});

// 2) No parallel Task*Event types in desktop-api
test('desktop-api must not define parallel TaskProgressEvent or TaskStatusEvent', () => {
  assert.doesNotMatch(apiSrc, /interface TaskProgressEvent/);
  assert.doesNotMatch(apiSrc, /interface TaskStatusEvent/);
});

// TypeScript build is the executable proof that this imported type and public listener agree.
test('desktop-api event listener uses the WorkerEvent source of truth', () => {
  assert.match(apiSrc, /import type \{ WorkerEvent \} from '\.\/worker-task';/);
  assert.match(apiSrc, /export type DesktopWorkerEvent = WorkerEvent;/);
  assert.match(apiSrc, /onWorkerEvent\(listener: DesktopWorkerEventListener\): \(\) => void;/);
  assert.doesNotMatch(apiSrc, /DESKTOP_WORKER_EVENT_LINK/);
});

// 4) Error envelope codes
test('DesktopIpcError must define required serializable error codes', () => {
  const codes = ['INVALID_INPUT', 'NOT_FOUND', 'PERMISSION_DENIED', 'CONFLICT', 'INTERNAL', 'CANCELLED'];
  for (const c of codes) {
    assert.match(apiSrc, new RegExp(`'${c}'`));
  }
  assert.match(apiSrc, /interface DesktopIpcError/);
  assert.match(apiSrc, /message:\s*string/);
});

// 5) Channel for pushed events
test('desktop-api must declare DESKTOP_EVENT_CHANNEL for pushed events', () => {
  assert.match(apiSrc, /DESKTOP_EVENT_CHANNEL/);
});

test('desktop-api exposes a typed before-close event for autosave flush', () => {
  assert.match(apiSrc, /onBeforeClose\(listener: DesktopBeforeCloseListener\): \(\) => void;/);
  assert.match(apiSrc, /DESKTOP_BEFORE_CLOSE_CHANNEL/);
});

test('subtitle import/export APIs accept binary bytes and never expose absolute paths', () => {
  assert.match(apiSrc, /importSubtitle\(req: ImportSubtitleRequest\)/);
  assert.match(apiSrc, /exportSourceSubtitle\(req: ExportSourceSubtitleRequest\)/);
  assert.match(apiSrc, /bytes: ArrayBuffer \| Uint8Array/);
  assert.match(apiSrc, /fileName: string/);
  assert.doesNotMatch(apiSrc, /absolutePath|filePath:\s*string|containerPath:\s*string/);
  assert.match(apiSrc, /Absolute paths are never accepted/);
});
