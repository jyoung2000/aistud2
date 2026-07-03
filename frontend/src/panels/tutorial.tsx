// Guided First Edit UI (B1): coach-mark bubbles that wait for the user to actually do
// each step on the real app. The bubbles reuse the tour's rect-tracking; the tutorial is
// fully skippable (Esc / ✕) and resumable from Help.
import { useEffect, useLayoutEffect, useState } from "react";
import { COLOR_GENERATION, COLOR_SELECTION } from "../constants";
import { modelsMeta } from "../api/referenceModels";
import { skipTutorial, tutorialNext, useTutorial } from "../state/tutorial";
import { setViewState } from "../state/viewState";

const STEPS: {
  step: number;
  target: string;
  color: string;
  text: React.ReactNode;
  waitFor: string;
}[] = [
  {
    step: 1,
    target: "canvas",
    color: COLOR_SELECTION,
    text: (
      <>
        We've switched you to the <b>⬚ Select tool</b> (in the left rail, shortcut{" "}
        <b>M</b>). Now <b>click the person</b> to select them.
      </>
    ),
    waitFor: "The cyan marching ants appearing is the payoff",
  },
  {
    step: 2,
    target: "generate",
    color: COLOR_GENERATION,
    text: (
      <>
        Now <b>describe a change</b> in the amber box below — we pre-filled “make the
        jacket golden”. Just <b>press Enter</b>.
      </>
    ),
    waitFor: "", // the preview-mode note renders separately (needs live key state)
  },
  {
    step: 3,
    target: "generate",
    color: COLOR_GENERATION,
    text: (
      <>
        Hit <b>Generate</b>. Only your selection is sent — watch the rest stay identical.
      </>
    ),
    waitFor: "",
  },
  {
    step: 4,
    target: "layers",
    color: "#e9ecf2",
    text: (
      <>
        Your edit landed as a <b>layer</b> — hide it, lower its opacity, or delete it. The
        original is untouched.
      </>
    ),
    waitFor: "",
  },
];

export function Tutorial({ onTour }: { onTour: () => void }) {
  const { step } = useTutorial();
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const def = STEPS.find((s) => s.step === step);

  // step 1: make sure the RIGHT tool is active — a first-run user shouldn't have to know
  // that clicking with Move selects layers, not pixels
  useEffect(() => {
    if (step === 1) window.dispatchEvent(new CustomEvent("neuclip:set-tool", { detail: "select" }));
  }, [step]);

  // suggest a prompt the user can just Enter (step 2)
  useEffect(() => {
    if (step === 2) window.dispatchEvent(new CustomEvent("neuclip:suggest-prompt", { detail: "make the jacket golden" }));
  }, [step]);

  // a failed generation during the tutorial gets an explanation, not a silent red chip
  useEffect(() => {
    const onFail = (e: Event) => setGenError((e as CustomEvent<string>).detail || "generation failed");
    window.addEventListener("neuclip:generate-failed", onFail);
    return () => window.removeEventListener("neuclip:generate-failed", onFail);
  }, []);
  useEffect(() => {
    setGenError(null); // clear the hint whenever the step moves on
  }, [step]);

  // after the generation completes (step 3 → 4): flash the Diff view for 2s — the proof
  useEffect(() => {
    if (step !== 4) return;
    setViewState({ viewMode: "diff" });
    const t = window.setTimeout(() => setViewState({ viewMode: "normal" }), 2200);
    return () => {
      window.clearTimeout(t);
      setViewState({ viewMode: "normal" });
    };
  }, [step]);

  useLayoutEffect(() => {
    if (!def) {
      setRect(null);
      return;
    }
    const measure = () => {
      const el = document.querySelector(`[data-tour="${def.target}"]`) as HTMLElement | null;
      setRect(el ? el.getBoundingClientRect() : null);
    };
    measure();
    const iv = window.setInterval(measure, 400); // targets move as panels appear
    window.addEventListener("resize", measure);
    return () => {
      window.clearInterval(iv);
      window.removeEventListener("resize", measure);
    };
  }, [def]);

  useEffect(() => {
    if (step === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") skipTutorial();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step]);

  if (step === 0) return null;

  // done card
  if (step === 5) {
    return (
      <div style={{ position: "fixed", inset: 0, zIndex: 2600, display: "grid", placeItems: "center", background: "rgba(4,8,14,0.6)" }}>
        <div style={{ width: 460, maxWidth: "92vw", background: "#12151a", border: "1px solid #2f3540", borderRadius: 14, padding: 24, font: "13px ui-sans-serif, system-ui, sans-serif", color: "#e2e8f0", boxShadow: "0 20px 60px #000c" }}>
          <div style={{ fontSize: 19, fontWeight: 700, marginBottom: 8 }}>That's the whole loop 🎉</div>
          <p style={{ color: "#aeb6c2", lineHeight: 1.6, margin: "0 0 16px" }}>
            <b style={{ color: COLOR_SELECTION }}>Select</b> →{" "}
            <b style={{ color: COLOR_GENERATION }}>describe</b> →{" "}
            <b style={{ color: COLOR_GENERATION }}>generate</b>. Everything else is depth.
          </p>
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <button
              onClick={() => skipTutorial()}
              style={{ padding: "8px 14px", borderRadius: 7, border: "1px solid #2a2f37", background: "transparent", color: "#cbd5e1", cursor: "pointer", fontSize: 13 }}
            >
              Explore on my own
            </button>
            <button
              onClick={() => {
                skipTutorial();
                onTour();
              }}
              style={{ padding: "8px 14px", borderRadius: 7, border: "none", background: COLOR_GENERATION, color: "#1a160e", cursor: "pointer", fontWeight: 700, fontSize: 13 }}
            >
              Replay the tour
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!def) return null;

  // bubble anchored beside the target (no dimming — the tutorial IS the product working)
  const pos: React.CSSProperties = rect
    ? def.target === "canvas"
      ? { left: rect.left + rect.width / 2 - 160, top: rect.top + 18 }
      : window.innerHeight - rect.bottom > 120
      ? { left: Math.max(8, Math.min(rect.left + 20, window.innerWidth - 340)), top: rect.bottom + 10 }
      : rect.top >= 130
      ? { left: Math.max(8, Math.min(rect.left + 20, window.innerWidth - 340)), top: rect.top - 10, transform: "translateY(-100%)" }
      : // tall side panels: sit just left of the target, inside the viewport
        { left: Math.max(8, rect.left - 336), top: Math.max(8, rect.top + 24) }
    : { left: "50%", top: 80, transform: "translateX(-50%)" };

  return (
    <div
      style={{
        position: "fixed",
        zIndex: 2600,
        width: 320,
        ...pos,
        background: "#12151a",
        border: `1.5px solid ${def.color}`,
        borderRadius: 10,
        padding: "12px 14px",
        font: "13px ui-sans-serif, system-ui, sans-serif",
        color: "#dbe3ee",
        boxShadow: "0 14px 40px #000b",
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
      }}
    >
      <span
        style={{
          flex: "0 0 auto",
          width: 20,
          height: 20,
          borderRadius: "50%",
          background: def.color,
          color: "#10141a",
          display: "grid",
          placeItems: "center",
          fontSize: 11,
          fontWeight: 700,
        }}
      >
        {step}
      </span>
      <span style={{ flex: 1, lineHeight: 1.5 }}>
        {def.text}
        {def.waitFor && <div style={{ color: "#7d8694", fontSize: 11, marginTop: 4 }}>{def.waitFor}</div>}
        {(step === 2 || step === 3) && (
          <div style={{ color: "#8a8371", fontSize: 11, marginTop: 5, lineHeight: 1.45 }}>
            {modelsMeta().hasKey
              ? "Runs on the real model — only your selection's crop is sent."
              : "No API key yet, so this runs in preview mode (a simulated edit) — perfect for learning. Add your WaveSpeed key in ⚙ Settings whenever you're ready for real models."}
          </div>
        )}
        {genError && (step === 2 || step === 3) && (
          <div style={{ color: "#f2c078", fontSize: 11, marginTop: 6, lineHeight: 1.45 }}>
            ⚠ That didn't go through: {genError.slice(0, 90)}.{" "}
            {modelsMeta().hasKey
              ? "Check your key in ⚙ Settings — then press Enter to retry."
              : "Press Enter to retry — preview mode needs no key."}
          </div>
        )}
        {step === 4 && (
          <button
            onClick={tutorialNext}
            style={{ marginTop: 8, padding: "4px 10px", borderRadius: 6, border: `1px solid ${def.color}`, background: "transparent", color: def.color, cursor: "pointer", fontSize: 11.5 }}
          >
            Next →
          </button>
        )}
      </span>
      <button
        onClick={skipTutorial}
        title="Skip the tutorial (Esc) — resume any time from ? Help"
        style={{ border: "none", background: "transparent", color: "#5c6473", cursor: "pointer", fontSize: 13, padding: 0 }}
      >
        ✕
      </button>
    </div>
  );
}
