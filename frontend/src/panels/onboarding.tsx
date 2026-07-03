// First-run onboarding: ONE welcome screen → the interface TOUR runs first (so the user
// knows where the tools are and what preview mode means BEFORE being asked to do
// anything) → then the Guided First Edit takes over on the real app
// (see panels/tutorial.tsx). The tour is also replayable from ? Help / Settings.
import { useEffect, useLayoutEffect, useState } from "react";
import { APP_NAME, COLOR_GENERATION, COLOR_SELECTION } from "../constants";
import type { HealthResponse } from "../api/sidecar";
import { startTutorial } from "../state/tutorial";
import { setTipsSuppressed } from "../ui/coachmarks";

const AMBER = COLOR_GENERATION;
const CYAN = COLOR_SELECTION;
export const ONBOARDED_KEY = "neuclip.onboarded.v3";

export function markOnboarded() {
  try {
    localStorage.setItem(ONBOARDED_KEY, "1");
  } catch {
    /* private mode — fine */
  }
}

export function hasOnboarded(): boolean {
  try {
    return localStorage.getItem(ONBOARDED_KEY) === "1";
  } catch {
    return false;
  }
}

type Rect = { top: number; left: number; width: number; height: number; bottom: number; right: number };

type Step = {
  key: string;
  target: string;
  color: string;
  title: string;
  body: React.ReactNode;
};

// The interface tour — runs BEFORE the guided first edit, in the order you'll use the
// app: tools → their options → layers → AI panel → generate → keys. The key stop sets
// the preview-vs-live expectation up front so a keyless first edit never reads as broken.
const STEPS: Step[] = [
  {
    key: "tools",
    target: "tools",
    color: CYAN,
    title: "1 · The tools (left rail)",
    body: (
      <>
        Top to bottom: <b>✥ Move</b> (V) moves layers · <b>⬚ Select</b> (M){" "}
        <u>the one to remember</u> — click your subject and it's selected ·{" "}
        <b>◠ Lasso</b> (L) draw by hand · <b>✎ Pen</b> editable curves ·{" "}
        <b>✦ Wand</b> similar colors · <b>🖌 Magic Brush</b> (W) paint roughly, AI snaps it
        · <b>✋ Hand</b> (H) pan. Hover any icon for its name.{" "}
        <span style={{ color: CYAN }}>Cyan = selection</span> everywhere in the app.
      </>
    ),
  },
  {
    key: "optionsbar",
    target: "optionsbar",
    color: CYAN,
    title: "2 · The active tool's options",
    body: (
      <>
        This bar always shows <b>only the current tool's options</b> — with Select active
        you get <b>⊙ Select subject</b> (one click finds the main subject) and
        select-by-text; the Wand gets tolerance, the Brush gets size and snap. Advanced
        selection ops sit behind <b>⋯ More</b>.
      </>
    ),
  },
  {
    key: "layers",
    target: "layers",
    color: "#e9ecf2",
    title: "3 · Layers (right)",
    body: (
      <>
        Every edit lands here as a <b>layer</b> — hide it, fade it, re-roll it, or delete
        it; your original pixels are never touched. The <b>getting-started checklist</b>{" "}
        at the top tracks your first steps.
      </>
    ),
  },
  {
    key: "inspector",
    target: "inspector",
    color: AMBER,
    title: "4 · The AI panel (amber = AI)",
    body: (
      <>
        Pick which <b>model</b> runs your edit, attach a <b>reference image</b> (replace /
        match-pose / match-style), stack <b>LoRAs</b>, or hit <b>Compare</b> to race
        several models on the same edit. Only the crop of your selection is ever sent.
      </>
    ),
  },
  {
    key: "generate",
    target: "generate",
    color: AMBER,
    title: "5 · Describe the change",
    body: (
      <>
        Select something, type what should happen (“make the jacket golden”), press{" "}
        <b>Generate</b>. Below the box you'll see the prompt <b>tuned for your model</b> —
        hover any phrase to see why it's there. Everything outside your selection stays
        pixel-identical.
      </>
    ),
  },
  {
    key: "keys",
    target: "settings",
    color: AMBER,
    title: "6 · Preview mode vs. live models",
    body: (
      <>
        <b>You can learn everything without an API key</b> — Generate runs in{" "}
        <b>preview mode</b> (a simulated edit) so the flow never blocks. When you want real
        AI models, add your <b>WaveSpeed key</b> here in ⚙ Settings — the AI panel also
        shows an amber <b>Add key</b> banner until you do.
        <div style={{ marginTop: 10 }}>
          <button
            onClick={() => window.dispatchEvent(new CustomEvent("neuclip:open-settings"))}
            style={{
              padding: "6px 12px",
              borderRadius: 6,
              border: `1px solid ${AMBER}`,
              background: "transparent",
              color: AMBER,
              cursor: "pointer",
              fontWeight: 700,
              fontSize: 12,
            }}
          >
            Add my key now
          </button>
          <span style={{ color: "#7d8694", fontSize: 11.5, marginLeft: 8 }}>
            or do it later — preview mode works fine
          </span>
        </div>
      </>
    ),
  },
];

const BUBBLE_W = 348;

export function Onboarding({
  open,
  onClose,
  mode = "welcome",
}: {
  open: boolean;
  onClose: () => void;
  health: HealthResponse | null;
  /** "welcome" = first-run screen; "tour" = jump straight into the interface tour. */
  mode?: "welcome" | "tour";
}) {
  // step -1 = welcome screen; 0..N-1 = tour stops
  const [step, setStep] = useState(mode === "tour" ? 0 : -1);
  const [rect, setRect] = useState<Rect | null>(null);
  // first-run path: after the tour ends, the guided first edit takes over
  const [thenTutorial, setThenTutorial] = useState(false);
  const s = step >= 0 ? STEPS[step] : null;

  useEffect(() => {
    if (open) {
      setStep(mode === "tour" ? 0 : -1);
      setThenTutorial(false);
    }
  }, [open, mode]);

  // coach marks stay quiet while the welcome/tour overlay owns the screen
  useEffect(() => {
    setTipsSuppressed(open);
    return () => setTipsSuppressed(false);
  }, [open]);

  // Measure the spotlighted element (and keep it in sync on resize/scroll/layout).
  useLayoutEffect(() => {
    if (!open || !s) {
      setRect(null);
      return;
    }
    let raf = 0;
    const measure = () => {
      const el = document.querySelector(`[data-tour="${s.target}"]`) as HTMLElement | null;
      if (!el) return setRect(null);
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height, bottom: r.bottom, right: r.right });
    };
    raf = requestAnimationFrame(measure);
    // targets can appear/move while the image loads behind the tour (e.g. the layers
    // panel only mounts once a document is open) — keep re-measuring
    const iv = window.setInterval(measure, 400);
    const on = () => measure();
    window.addEventListener("resize", on);
    window.addEventListener("scroll", on, true);
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(iv);
      window.removeEventListener("resize", on);
      window.removeEventListener("scroll", on, true);
    };
  }, [open, step, s]);

  // keyboard: →/Enter next, ← back, Esc skip
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
      else if (step >= 0 && (e.key === "ArrowRight" || e.key === "Enter"))
        setStep((x) => (x >= STEPS.length - 1 ? (finish(), x) : x + 1));
      else if (step >= 0 && e.key === "ArrowLeft") setStep((x) => Math.max(0, x - 1));
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step]);

  if (!open) return null;

  const finish = () => {
    markOnboarded();
    onClose();
    // first-run: the tour taught the map — now the guided first edit teaches the loop
    if (thenTutorial) startTutorial();
  };
  const startWith = (evt: "neuclip:open-sample" | "neuclip:open-image") => {
    markOnboarded();
    // open the image behind the tour, then walk the interface FIRST — the user learns
    // where the tools are (and what preview mode is) before being asked to do anything
    window.dispatchEvent(new CustomEvent(evt));
    setThenTutorial(true);
    setStep(0);
  };

  // ---------- welcome (one screen, two buttons) ----------
  if (step === -1) {
    return (
      <div style={{ position: "fixed", inset: 0, zIndex: 2000 }}>
        <div style={{ position: "absolute", inset: 0, background: "rgba(4,8,14,0.85)" }} />
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", padding: 16 }}>
          <div style={{ ...centerCard, textAlign: "center", width: 480 }}>
            <div style={{ fontSize: 24, fontWeight: 700, marginBottom: 10 }}>{APP_NAME}</div>
            <p style={{ color: "#aeb6c2", lineHeight: 1.55, fontSize: 14, margin: "0 0 10px" }}>
              Select anything. Change only that.
              <br />
              Everything else stays pixel-perfect.
            </p>
            <p style={{ color: "#7d8694", lineHeight: 1.5, fontSize: 12, margin: "0 0 20px" }}>
              First a 30-second tour of where everything lives, then you'll make your first
              edit — no API key needed to try it.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
              <button
                onClick={() => startWith("neuclip:open-sample")}
                style={{ ...primaryBtn, background: AMBER, fontSize: 14, padding: "11px 26px" }}
              >
                Start with the sample photo
              </button>
              <button onClick={() => startWith("neuclip:open-image")} style={{ ...ghostBtn, fontSize: 13 }}>
                Open my own image
              </button>
            </div>
            <button
              onClick={finish}
              style={{ position: "absolute", right: 18, bottom: 14, border: "none", background: "transparent", color: "#5c6473", fontSize: 12, cursor: "pointer" }}
            >
              Skip
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---------- spotlight tour ----------
  const next = () => (step >= STEPS.length - 1 ? finish() : setStep(step + 1));
  const back = () => setStep(Math.max(0, step - 1));
  const color = s!.color;
  const spotlighting = !!rect;

  const nav = (
    <Nav
      step={step}
      total={STEPS.length}
      onBack={back}
      onNext={next}
      onSkip={finish}
      color={color}
      lastLabel={thenTutorial ? "Start my first edit" : "Done"}
    />
  );

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 2000 }}>
      <style>{PULSE_CSS}</style>
      {spotlighting ? (
        <>
          <div style={{ position: "absolute", inset: 0 }} onClick={(e) => e.stopPropagation()} />
          <div
            style={{
              position: "absolute",
              top: rect!.top - 6,
              left: rect!.left - 6,
              width: rect!.width + 12,
              height: rect!.height + 12,
              borderRadius: 10,
              boxShadow: `0 0 0 9999px rgba(4,8,14,0.78)`,
              border: `2px solid ${color}`,
              outline: `2px solid ${color}55`,
              pointerEvents: "none",
              animation: "neu-pulse 1.8s ease-in-out infinite",
              transition: "top .18s, left .18s, width .18s, height .18s",
            }}
          />
          <Callout rect={rect!} color={color} title={s!.title} body={s!.body} nav={nav} />
        </>
      ) : (
        <>
          <div style={{ position: "absolute", inset: 0, background: "rgba(4,8,14,0.82)" }} />
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", padding: 16 }}>
            <div style={centerCard}>
              <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8, color }}>{s!.title}</div>
              <div style={{ color: "#c2cad6", lineHeight: 1.6 }}>{s!.body}</div>
              <div style={{ marginTop: 18 }}>{nav}</div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Position the callout bubble on whichever side of the target has room. */
function Callout({
  rect,
  color,
  title,
  body,
  nav,
}: {
  rect: Rect;
  color: string;
  title: string;
  body: React.ReactNode;
  nav: React.ReactNode;
}) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const gap = 14;
  const clampX = (x: number) => Math.max(10, Math.min(x, vw - BUBBLE_W - 10));
  const cx = rect.left + rect.width / 2;

  let style: React.CSSProperties;
  if (vh - rect.bottom >= 220) {
    style = { top: rect.bottom + gap, left: clampX(cx - BUBBLE_W / 2) };
  } else if (rect.top >= 220) {
    style = { top: rect.top - gap, left: clampX(cx - BUBBLE_W / 2), transform: "translateY(-100%)" };
  } else if (rect.left >= BUBBLE_W + gap + 10) {
    style = { top: Math.max(10, Math.min(rect.top, vh - 240)), left: rect.left - gap, transform: "translateX(-100%)" };
  } else {
    style = { top: Math.max(10, Math.min(rect.top, vh - 240)), left: Math.min(rect.right + gap, vw - BUBBLE_W - 10) };
  }

  return (
    <div
      style={{
        position: "absolute",
        width: BUBBLE_W,
        maxWidth: "92vw",
        background: "#12151a",
        border: `1px solid ${color}`,
        borderRadius: 12,
        padding: 16,
        color: "#e2e8f0",
        font: "13px ui-sans-serif, system-ui, sans-serif",
        boxShadow: "0 16px 50px #000b",
        ...style,
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8, color }}>{title}</div>
      <div style={{ color: "#c8d0dc", lineHeight: 1.55, fontSize: 13 }}>{body}</div>
      <div style={{ marginTop: 14 }}>{nav}</div>
    </div>
  );
}

function Nav({
  step,
  total,
  onBack,
  onNext,
  onSkip,
  color,
  lastLabel = "Start editing",
}: {
  step: number;
  total: number;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
  color: string;
  lastLabel?: string;
}) {
  const last = step === total - 1;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", rowGap: 8 }}>
      <div style={{ display: "flex", gap: 4 }}>
        {Array.from({ length: total }).map((_, i) => (
          <span
            key={i}
            style={{ width: i === step ? 16 : 6, height: 6, borderRadius: 3, background: i === step ? color : "#333a45", transition: "all .2s" }}
          />
        ))}
      </div>
      <div style={{ flex: 1 }} />
      <button onClick={onSkip} style={{ border: "none", background: "transparent", color: "#6b7280", fontSize: 12, cursor: "pointer" }}>
        Skip
      </button>
      {step > 0 && (
        <button onClick={onBack} style={ghostBtn}>
          Back
        </button>
      )}
      <button onClick={onNext} style={{ ...primaryBtn, background: color }}>
        {last ? lastLabel : "Next"}
      </button>
    </div>
  );
}

const PULSE_CSS = `@keyframes neu-pulse {0%,100%{outline-offset:0}50%{outline-offset:4px}}`;

const centerCard: React.CSSProperties = {
  position: "relative",
  width: 520,
  maxWidth: "94vw",
  maxHeight: "88vh",
  overflowY: "auto",
  background: "#12151a",
  border: "1px solid #2a2f37",
  borderRadius: 14,
  padding: 24,
  color: "#e2e8f0",
  font: "13px ui-sans-serif, system-ui, sans-serif",
  boxShadow: "0 20px 60px #000c",
};
const primaryBtn: React.CSSProperties = {
  padding: "8px 16px",
  borderRadius: 7,
  border: "none",
  cursor: "pointer",
  fontWeight: 700,
  color: "#1a160e",
  background: AMBER,
  fontSize: 13,
};
const ghostBtn: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: 7,
  border: "1px solid #2a2f37",
  cursor: "pointer",
  color: "#cbd5e1",
  background: "transparent",
  fontSize: 13,
};
