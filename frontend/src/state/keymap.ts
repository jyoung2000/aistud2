// User-remappable keyboard map. Remappable actions are the single-key bindings (tools +
// a few canvas actions); chorded shortcuts (⌘Z, ⌘D, …) are listed for reference but stay
// fixed — they follow platform conventions and colliding with the browser is not worth a
// remap UI. Overrides persist in localStorage (`neuclip.keymap`) as {actionId: key}.
import { useSyncExternalStore } from "react";

export interface RemappableAction {
  id: string;
  label: string;
  group: "Tools" | "Canvas";
  def: string; // default key (lowercase, single printable character)
  /** extra reading, e.g. "Shift+<key> cycles lasso modes" */
  note?: string;
}

export const REMAPPABLE: RemappableAction[] = [
  { id: "tool.move", label: "Move tool", group: "Tools", def: "v" },
  { id: "tool.select", label: "Select tool", group: "Tools", def: "m" },
  { id: "tool.lasso", label: "Lasso tool", group: "Tools", def: "l", note: "Shift+key cycles Freehand / Polygon / Magnetic" },
  { id: "tool.pen", label: "Pen tool", group: "Tools", def: "p" },
  { id: "tool.brush", label: "Magic Brush", group: "Tools", def: "w", note: "Shift+key toggles Magic Wand ↔ Brush" },
  { id: "tool.hand", label: "Hand (pan)", group: "Tools", def: "h" },
];

/** Fixed (non-remappable) shortcuts, for the reference list. */
export const FIXED_BINDS: { keys: string; label: string; group: string }[] = [
  { keys: "Esc", label: "Deselect everything (or cancel the active gesture)", group: "Selection" },
  { keys: "⌘D", label: "Deselect", group: "Selection" },
  { keys: "⌘A", label: "Select all", group: "Selection" },
  { keys: "⌘⇧I", label: "Invert selection", group: "Selection" },
  { keys: "Shift-click", label: "Add another object to the selection (Ctrl-click too)", group: "Selection" },
  { keys: "Alt-click", label: "Remove an object from the selection", group: "Selection" },
  { keys: "[ ]", label: "Brush size / magnetic width", group: "Selection" },
  { keys: "Enter", label: "Commit lasso / pen / brush selection", group: "Selection" },
  { keys: "⌘J", label: "Layer via copy (selection → new layer)", group: "Layers" },
  { keys: "Delete", label: "Delete selected layer(s)", group: "Layers" },
  { keys: "⌘Z / ⌘⇧Z / ⌘Y", label: "Undo / redo", group: "Edit" },
  { keys: "⌘S", label: "Save .neuclip project", group: "File" },
  { keys: "⌘O", label: "Open image", group: "File" },
  { keys: "⌘+ / ⌘−", label: "Zoom in / out", group: "View" },
  { keys: "⌘0 / ⌘1", label: "Fit / 100%", group: "View" },
  { keys: "Space-drag", label: "Pan (any tool)", group: "View" },
  { keys: "⌘K", label: "Feature Finder — where is…?", group: "Help" },
  { keys: "?", label: "This shortcuts panel", group: "Help" },
];

const STORE_KEY = "neuclip.keymap";

function loadOverrides(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const data = raw ? JSON.parse(raw) : {};
    return typeof data === "object" && data ? data : {};
  } catch {
    return {};
  }
}

let overrides: Record<string, string> = loadOverrides();
const listeners = new Set<() => void>();

function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(overrides));
  } catch {
    /* private mode */
  }
  for (const l of listeners) l();
}

/** The active key for an action (lowercase). */
export function keyFor(actionId: string): string {
  const o = overrides[actionId];
  if (o) return o;
  return REMAPPABLE.find((a) => a.id === actionId)?.def ?? "";
}

/** The action bound to a key, or null. */
export function actionForKey(key: string): string | null {
  const k = key.toLowerCase();
  for (const a of REMAPPABLE) {
    if (keyFor(a.id) === k) return a.id;
  }
  return null;
}

/** Rebind an action. A key already bound elsewhere is STOLEN from the other action
 *  (which falls back to unbound-shown-as-conflict until re-assigned or reset).
 *  Returns the action the key was stolen from, if any. */
export function setKeyFor(actionId: string, key: string): string | null {
  const k = key.toLowerCase();
  let stolenFrom: string | null = null;
  for (const a of REMAPPABLE) {
    if (a.id !== actionId && keyFor(a.id) === k) {
      stolenFrom = a.id;
      overrides[a.id] = ""; // unbound until the user assigns something else
    }
  }
  overrides = { ...overrides, [actionId]: k };
  persist();
  return stolenFrom;
}

export function resetKeymap(): void {
  overrides = {};
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    /* private mode */
  }
  for (const l of listeners) l();
}

let snapshot = 0;
function subscribe(l: () => void) {
  const wrapped = () => {
    snapshot++;
    l();
  };
  listeners.add(wrapped);
  return () => listeners.delete(wrapped);
}

/** Re-render on keymap changes; returns a change counter (read keys via keyFor). */
export function useKeymap(): number {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}
