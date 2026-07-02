// App milestone bus — one place where "the user just did X" is announced. The guided
// tutorial, the getting-started checklist, and contextual coach marks all subscribe here
// instead of prop-drilling callbacks through the canvas.
import { useSyncExternalStore } from "react";

export type Milestone =
  | "image-open"
  | "select" // a non-empty selection exists
  | "prompt" // the user typed in the prompt field
  | "generate" // a generation completed
  | "layers" // any layers-panel interaction
  | "abview" // A|B or Diff view used
  | "reference" // a reference image attached
  | "compare" // compare mode toggled on
  | "import" // import-image-as-layer used
  | "save" // project saved / exported
  | "second-ai-edit"; // a 2nd ai-edit layer exists

type Listener = (m: Milestone) => void;
const listeners = new Set<Listener>();

export function onMilestone(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function emitMilestone(m: Milestone): void {
  for (const l of [...listeners]) l(m);
  bumpChecklist(m);
}

// --- getting-started checklist (B5) -----------------------------------------
export const CHECKLIST_KEY = "neuclip.checklist.v1";

export interface ChecklistState {
  done: Record<string, boolean>;
  dismissed: boolean;
}

export const CHECKLIST_ITEMS: { key: string; label: string; milestone: Milestone; finderKey: string }[] = [
  { key: "select", label: "Make a selection", milestone: "select", finderKey: "smart-select" },
  { key: "generate", label: "Generate an edit", milestone: "generate", finderKey: "generate" },
  { key: "abview", label: "Try the A|B view", milestone: "abview", finderKey: "view-modes" },
  { key: "reference", label: "Attach a reference", milestone: "reference", finderKey: "reference" },
  { key: "save", label: "Save a project", milestone: "save", finderKey: "save-project" },
];

function readChecklist(): ChecklistState {
  try {
    return JSON.parse(localStorage.getItem(CHECKLIST_KEY) || "") as ChecklistState;
  } catch {
    return { done: {}, dismissed: false };
  }
}

let checklist = readChecklist();
const clListeners = new Set<() => void>();

function writeChecklist(next: ChecklistState) {
  checklist = next;
  try {
    localStorage.setItem(CHECKLIST_KEY, JSON.stringify(next));
  } catch {
    /* private mode */
  }
  for (const l of clListeners) l();
}

function bumpChecklist(m: Milestone) {
  const item = CHECKLIST_ITEMS.find((i) => i.milestone === m);
  if (!item || checklist.done[item.key]) return;
  writeChecklist({ ...checklist, done: { ...checklist.done, [item.key]: true } });
}

export function dismissChecklist() {
  writeChecklist({ ...checklist, dismissed: true });
}

export function checklistComplete(): boolean {
  return CHECKLIST_ITEMS.every((i) => checklist.done[i.key]);
}

const getChecklist = () => checklist;
function subscribeChecklist(l: () => void) {
  clListeners.add(l);
  return () => clListeners.delete(l);
}
export function useChecklist(): ChecklistState {
  return useSyncExternalStore(subscribeChecklist, getChecklist, getChecklist);
}
