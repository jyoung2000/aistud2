// Shared generation config — the bridge between the inspector (model + reference/pose + LoRAs)
// and the canvas's Generate action (reference milestone M3). The two panels are siblings with
// no common ancestor state, so this tiny external store carries the inspector's choices to the
// canvas at generate time. Fairness/crop contracts still live in the sidecar; this only moves
// the *inputs* across.
import { useSyncExternalStore } from "react";

export interface GenLora {
  ref: string;
  weight: number;
  trigger_words: string[];
}

export interface GenConfig {
  /** Registry model id/slug the sidecar resolves; null → mock path. */
  modelId: string | null;
  modelLabel: string | null;
  /** Reference role in effect (replace | pose | style), or null when the model takes none. */
  referenceRole: "replace" | "pose" | "style" | null;
  /** Data URL sent as the reference: the pose control image (pose) or the reference image
   *  (replace/style). null when no reference is attached. */
  referencePng: string | null;
  /** 0..1 — pose/style strength → control_strength. */
  controlStrength: number;
  /** The hand-edited pose skeleton, stored on the resulting layer for re-editing. */
  pose?: unknown;
  loras: GenLora[];
  /** Compare mode (shootout M3): when on, Generate fans the edit across compareSet. */
  compareMode: boolean;
  compareSet: string[];
}

const DEFAULT: GenConfig = {
  modelId: null,
  modelLabel: null,
  referenceRole: null,
  referencePng: null,
  controlStrength: 1,
  pose: undefined,
  loras: [],
  compareMode: false,
  compareSet: [],
};

let state: GenConfig = DEFAULT;
const listeners = new Set<() => void>();

export function getGenConfig(): GenConfig {
  return state;
}

export function setGenConfig(patch: Partial<GenConfig>): void {
  const next = { ...state, ...patch };
  // Skip a notify if nothing actually changed (avoids render loops from effects).
  if (shallowEqual(next, state)) return;
  state = next;
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useGenConfig(): GenConfig {
  return useSyncExternalStore(subscribe, getGenConfig, getGenConfig);
}

function shallowEqual(a: GenConfig, b: GenConfig): boolean {
  return (
    a.modelId === b.modelId &&
    a.modelLabel === b.modelLabel &&
    a.referenceRole === b.referenceRole &&
    a.referencePng === b.referencePng &&
    a.controlStrength === b.controlStrength &&
    a.pose === b.pose &&
    a.loras === b.loras &&
    a.compareMode === b.compareMode &&
    a.compareSet === b.compareSet
  );
}
