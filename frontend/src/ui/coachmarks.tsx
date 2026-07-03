// Contextual coach marks (B2): one-time, dismissible, single-sentence bubbles fired the
// FIRST time a trigger occurs. Max ONE visible at a time, never during the guided
// tutorial, killable globally in Settings.
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { isTutorialActive } from "../state/tutorial";

export const TIPS_DISABLED_KEY = "neuclip.tips.disabled";
const tipKey = (k: string) => `neuclip.tip.${k}`;

export function tipsDisabled(): boolean {
  try {
    return localStorage.getItem(TIPS_DISABLED_KEY) === "1";
  } catch {
    return false;
  }
}
export function setTipsDisabled(v: boolean): void {
  try {
    localStorage.setItem(TIPS_DISABLED_KEY, v ? "1" : "0");
  } catch {
    /* private mode */
  }
  if (v) hide();
}

/** The full tip map — how every OTHER feature gets introduced at the moment of relevance. */
const TIPS: Record<string, { target: string; text: string }> = {
  toolrail: { target: "tools", text: "Tools live here — hover any for its shortcut." },
  "selection-ops": { target: "optionsbar", text: "Shift adds to a selection, Alt subtracts, ⌘D deselects." },
  lasso: { target: "tools", text: "Long-press the lasso for Freehand / Polygon / Magnetic — Magnetic snaps to edges." },
  brush: { target: "optionsbar", text: "Paint roughly — AI snaps it to the subject. [ and ] resize." },
  pen: { target: "optionsbar", text: "Click = corner, drag = curve, Alt-click toggles smooth, Enter commits." },
  wand: { target: "optionsbar", text: "Tolerance sets how similar colors must be; uncheck contiguous to grab them everywhere." },
  "layer-stack": { target: "layers", text: "Stack edits: each is independent — reorder, blend, or re-roll (↻) any of them." },
  "reference-roles": { target: "inspector", text: "Roles matter: Replace swaps the subject in; Pose copies only the posture." },
  compare: { target: "inspector", text: "Same edit, several models, one winner — costs add up, shown here." },
  "import-flatten": { target: "filebar", text: "Imported layers are invisible to the AI until you Flatten for AI." },
  viewmodes: { target: "viewmodes", text: "A|B swipes before/after; Diff proves what changed." },
  "ready-to-generate": { target: "generate", text: "Ready — describe the change below, or refine the edge first (✦)." },
  "save-export": { target: "filemenu", text: ".neuclip keeps every layer editable; Export flattens to a normal image." },
  "gpu-idle": { target: "devicebadge", text: "Your GPU is idle — the GPU build makes selection instant. Grab it in Settings." },
};

let visible: { key: string; target: string; text: string } | null = null;
const listeners = new Set<() => void>();
const get = () => visible;
function emit() {
  for (const l of listeners) l();
}
function hide() {
  visible = null;
  emit();
}

// The welcome/tour overlay suppresses tips entirely — a coach mark popping over (or
// under) the tour is noise; the tip stays unconsumed and fires at its next trigger.
let overlayActive = false;
export function setTipsSuppressed(v: boolean): void {
  overlayActive = v;
  if (v) hide();
}

/** Fire a tip by key: shows once ever, one at a time, never during the tutorial/tour. */
export function fireTip(key: keyof typeof TIPS | string): void {
  const def = TIPS[key as string];
  if (!def || visible || tipsDisabled() || isTutorialActive() || overlayActive) return;
  try {
    if (localStorage.getItem(tipKey(key as string)) === "1") return;
    localStorage.setItem(tipKey(key as string), "1");
  } catch {
    return;
  }
  visible = { key: key as string, ...def };
  emit();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function CoachMarks() {
  const tip = useSyncExternalStore(subscribe, get, get);
  const [rect, setRect] = useState<DOMRect | null>(null);

  useLayoutEffect(() => {
    if (!tip) {
      setRect(null);
      return;
    }
    const measure = () => {
      const el = document.querySelector(`[data-tour="${tip.target}"]`) as HTMLElement | null;
      setRect(el ? el.getBoundingClientRect() : null);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [tip]);

  useEffect(() => {
    if (!tip) return;
    const t = window.setTimeout(hide, 9000);
    return () => window.clearTimeout(t);
  }, [tip]);

  if (!tip || !rect) return null;
  const below = window.innerHeight - rect.bottom > 90;
  const above = !below && rect.top > 90;
  // tall full-height targets (the tool rail) fit neither above nor below → sit beside
  const pos: React.CSSProperties = below
    ? { top: rect.bottom + 10, left: Math.max(8, Math.min(rect.left + rect.width / 2 - 150, window.innerWidth - 310)) }
    : above
    ? { bottom: window.innerHeight - rect.top + 10, left: Math.max(8, Math.min(rect.left + rect.width / 2 - 150, window.innerWidth - 310)) }
    : { top: Math.max(8, rect.top + 12), left: Math.min(rect.right + 10, window.innerWidth - 310) };
  return (
    <div
      style={{
        position: "fixed",
        zIndex: 2500,
        ...pos,
        width: 300,
        background: "#12151a",
        border: "1px solid #38bdf866",
        borderLeft: "3px solid #38bdf8",
        borderRadius: 8,
        padding: "9px 12px",
        font: "12px ui-sans-serif, system-ui, sans-serif",
        color: "#c8d0dc",
        boxShadow: "0 10px 30px #000a",
        display: "flex",
        gap: 8,
        alignItems: "flex-start",
      }}
    >
      <span style={{ color: "#38bdf8" }}>💡</span>
      <span style={{ flex: 1, lineHeight: 1.45 }}>{tip.text}</span>
      <button
        onClick={hide}
        title="Dismiss (tips can be turned off in Settings)"
        style={{ border: "none", background: "transparent", color: "#5c6473", cursor: "pointer", fontSize: 12, padding: 0 }}
      >
        ✕
      </button>
    </div>
  );
}
