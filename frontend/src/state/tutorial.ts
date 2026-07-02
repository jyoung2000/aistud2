// Guided First Edit (B1) — a 4-step learn-by-doing tutorial that runs on the REAL app
// (mock path, no key needed). Each step waits for the user to actually DO the thing;
// advancement events are the app milestones, instrumented where they already happen.
import { useSyncExternalStore } from "react";
import { onMilestone, type Milestone } from "./milestones";

export type TutorialStep = 0 | 1 | 2 | 3 | 4 | 5; // 0 = inactive, 5 = done card

interface TutorialState {
  step: TutorialStep;
}

let state: TutorialState = { step: 0 };
const listeners = new Set<() => void>();

function set(step: TutorialStep) {
  if (state.step === step) return;
  state = { step };
  for (const l of listeners) l();
}

export function isTutorialActive(): boolean {
  return state.step > 0 && state.step < 5;
}

export function startTutorial(): void {
  set(1);
}

export function skipTutorial(): void {
  set(0);
}

export function tutorialNext(): void {
  set(state.step >= 5 ? 0 : ((state.step + 1) as TutorialStep));
}

const ADVANCE: Partial<Record<Milestone, TutorialStep>> = {
  select: 1, // completing step 1 → go to 2
  prompt: 2,
  generate: 3,
  layers: 4,
};

// milestones advance the matching step (only the CURRENT one — no skipping ahead)
onMilestone((m) => {
  const stepFor = ADVANCE[m];
  if (stepFor && state.step === stepFor) {
    set((state.step + 1) as TutorialStep);
  }
});

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
const get = () => state;

export function useTutorial(): TutorialState {
  return useSyncExternalStore(subscribe, get, get);
}
