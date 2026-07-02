// Shared view/status state — the bridge between the canvas (which owns the image, the
// selection, and the diff computation) and the StatusBar (which now hosts the view-mode
// switch, the swipe slider, the diff readout, the cursor readout, and the backend badge).
// Same external-store pattern as state/genConfig.ts — the two components are not
// parent/child, and prop-drilling through App would touch every layer between them.
import { useSyncExternalStore } from "react";

export type ViewMode = "normal" | "split" | "diff";

export interface ViewState {
  hasImage: boolean;
  viewMode: ViewMode;
  swipe: number; // 0..1 — split-view divider
  diffPct: number | null; // % changed pixels (diff view only)
  cursor: { x: number; y: number } | null; // image-space cursor
  selPct: number; // selection area as % of the document
  backend: string | null; // "sam2" | "fallback" | null
  busy: boolean; // a select/refine call is in flight
}

const DEFAULT: ViewState = {
  hasImage: false,
  viewMode: "normal",
  swipe: 0.5,
  diffPct: null,
  cursor: null,
  selPct: 0,
  backend: null,
  busy: false,
};

let state: ViewState = DEFAULT;
const listeners = new Set<() => void>();

export function getViewState(): ViewState {
  return state;
}

export function setViewState(patch: Partial<ViewState>): void {
  let changed = false;
  for (const k of Object.keys(patch) as (keyof ViewState)[]) {
    if (state[k] !== patch[k]) {
      changed = true;
      break;
    }
  }
  if (!changed) return;
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useViewState(): ViewState {
  return useSyncExternalStore(subscribe, getViewState, getViewState);
}
