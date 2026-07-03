// Guided First Edit (B1) — a 4-step learn-by-doing tutorial that runs on the REAL app
// (mock path, no key needed). Each step waits for the user to actually DO the thing;
// advancement events are the app milestones, instrumented where they already happen.
import { useSyncExternalStore } from "react";
import { onMilestone } from "./milestones";

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

// Milestones advance the tutorial. Mostly strict (the current step's milestone moves it
// one forward), with one deliberate exception: a completed GENERATION jumps from step 2
// OR 3 to 4 — the prompt is pre-filled on step 2, so a user who just presses Enter never
// fires the "prompt" (typing) milestone and used to strand the tutorial on step 2.
onMilestone((m) => {
  if (state.step === 0 || state.step >= 5) return;
  if (m === "select" && state.step === 1) set(2);
  else if (m === "prompt" && state.step === 2) set(3);
  else if (m === "generate" && (state.step === 2 || state.step === 3)) set(4);
  else if (m === "layers" && state.step === 4) set(5);
});

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
const get = () => state;

export function useTutorial(): TutorialState {
  return useSyncExternalStore(subscribe, get, get);
}
