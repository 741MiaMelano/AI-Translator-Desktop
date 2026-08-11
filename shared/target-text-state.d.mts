export interface TargetTextLayerState {
  model: string;
  postProcessed: string;
  manual?: string;
  previousManual?: string;
  locked?: boolean;
  stale?: boolean;
  qaFlags: string[];
}

export interface TargetTextTransitionResult {
  ok: boolean;
  skipped: boolean;
  reason?: string;
  layer: TargetTextLayerState;
}

export function createEmptyTargetTextLayers(): TargetTextLayerState;
export function getEffectiveTargetText(layer: TargetTextLayerState | undefined | null): string;
export function isLockedTargetLayer(layer: TargetTextLayerState | undefined | null): boolean;
export function hasManualTargetText(layer: TargetTextLayerState | undefined | null): boolean;
export function hasPreviousManualTargetText(layer: TargetTextLayerState | undefined | null): boolean;
export function isAutoProtectedTargetLayer(layer: TargetTextLayerState | undefined | null): boolean;
export function isProtectedTargetLayer(layer: TargetTextLayerState | undefined | null): boolean;
export function isStaleTargetLayer(layer: TargetTextLayerState | undefined | null): boolean;
export function applyAutomaticModelText(
  layer: TargetTextLayerState | undefined | null,
  text: string,
): TargetTextTransitionResult;
export function applyBatchReplace(
  layer: TargetTextLayerState | undefined | null,
  findText: string,
  replaceText: string,
): TargetTextTransitionResult;
export function applyCandidateAdopt(
  layer: TargetTextLayerState | undefined | null,
  candidateText: string,
  options?: { force?: boolean },
): TargetTextTransitionResult;
export function applyExplicitRerunResult(
  layer: TargetTextLayerState | undefined | null,
  text: string,
): TargetTextTransitionResult;
export function revertToPreviousManual(
  layer: TargetTextLayerState | undefined | null,
): TargetTextTransitionResult;
export function setManualTargetText(
  layer: TargetTextLayerState | undefined | null,
  manualText: string,
  options?: { preserveEmpty?: boolean },
): TargetTextTransitionResult;
export function setLockedTargetText(
  layer: TargetTextLayerState | undefined | null,
  locked: boolean,
): TargetTextTransitionResult;
export function markStaleTargetText(
  layer: TargetTextLayerState | undefined | null,
): TargetTextTransitionResult;
export function clearStaleTargetText(
  layer: TargetTextLayerState | undefined | null,
): TargetTextTransitionResult;
