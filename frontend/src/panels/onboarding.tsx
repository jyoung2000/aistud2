import { useEffect, useLayoutEffect, useState } from "react";
import { APP_NAME, COLOR_GENERATION, COLOR_SELECTION } from "../constants";
import type { HealthResponse } from "../api/sidecar";
import { getSettings, saveSettings, type SettingsStatus } from "../api/settings";
import { loadModels, modelsMeta } from "../api/referenceModels";

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
  /** data-tour id of the real UI element to spotlight (omit for centered panels). */
  target?: string;
  color?: string;
  title: string;
  body: React.ReactNode;
  /** Special centered content instead of a callout. */
  panel?: "welcome" | "keys" | "done";
};

// The tour walks the real interface top-to-bottom, spotlighting each element as it explains it.
const STEPS: Step[] = [
  { key: "welcome", panel: "welcome", title: "", body: null },
  { key: "keys", panel: "keys", title: "", body: null },
  {
    key: "open",
    target: "open",
    color: CYAN,
    title: "1 · Open an image here",
    body: (
      <>
        Click <b>Open image</b> (top-left) to load a photo — or drop one on the canvas. On open, the
        app <b>auto-separates</b> the picture into editable layers (people, background, objects). The
        original is never modified.
      </>
    ),
  },
  {
    key: "tools",
    target: "tools",
    color: CYAN,
    title: "2 · Your tools live here",
    body: (
      <div style={{ display: "grid", gap: 5 }}>
        <Tool icon="✥" name="Move (V)" desc="pick up & scale whole layers" />
        <Tool icon="⬚" name="Select (M)" desc="smart AI select — click the subject" />
        <Tool icon="◠" name="Lasso" desc="freehand / polygon / edge-snapping outline" />
        <Tool icon="✎" name="Pen" desc="precise, editable curves" />
        <Tool icon="✋" name="Hand" desc="pan around (or hold Space)" />
        <div style={{ marginTop: 3, color: "#9aa4b2" }}>
          Selections show as <span style={{ color: CYAN }}>cyan marching ants</span>. Hold{" "}
          <b>Shift</b> to add to a selection, <b>Alt</b> to subtract.
        </div>
      </div>
    ),
  },
  {
    key: "filebar",
    target: "filebar",
    color: "#8ab4f8",
    title: "3 · File & canvas actions",
    body: (
      <>
        Open/Save a <code>.neuclip</code> project, <b>+ Import image</b> to drop another photo in as
        a movable layer, <b>⤵ Flatten for AI</b> to bake layers into the base, <b>Auto-separate</b>,
        plus <b>Crop</b> / <b>Extend</b> and adjustment layers.
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
        Pick a <b>model</b>, attach a <b>reference image</b> (replace / match-pose / style), stack{" "}
        <b>LoRAs</b>, or turn on <b>Compare</b> to run several models at once. Only the <b>crop of
        your selection</b> is ever sent — the rest of the photo stays untouched.
      </>
    ),
  },
  {
    key: "generate",
    target: "generate",
    color: AMBER,
    title: "5 · Describe it & Generate",
    body: (
      <>
        Type what you want for the selected area, then hit <b>Generate</b>. The result composites
        back through a soft edge and drops in as a <b>re-editable layer</b> — edit it, re-roll it, or
        stack more edits. The readout shows which model + reference will run.
      </>
    ),
  },
  {
    key: "settings",
    target: "settings",
    color: "#cbd5e1",
    title: "6 · Settings & this tour",
    body: (
      <>
        Your <b>API keys</b>, <b>GPU status</b>, the live model list, and a <b>Show walkthrough</b>{" "}
        button to reopen this tour all live here.
      </>
    ),
  },
  { key: "done", panel: "done", title: "", body: null },
];

const BUBBLE_W = 348;

export function Onboarding({
  open,
  onClose,
  health,
}: {
  open: boolean;
  onClose: () => void;
  health: HealthResponse | null;
}) {
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const s = STEPS[step];

  useEffect(() => {
    if (open) setStep(0);
  }, [open]);

  // Measure the spotlighted element (and keep it in sync on resize/scroll/layout).
  useLayoutEffect(() => {
    if (!open || !s.target) {
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
    const on = () => measure();
    window.addEventListener("resize", on);
    window.addEventListener("scroll", on, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", on);
      window.removeEventListener("scroll", on, true);
    };
  }, [open, step, s.target]);

  // keyboard: →/Enter next, ← back, Esc skip
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
      else if (e.key === "ArrowRight" || e.key === "Enter") setStep((x) => Math.min(x + 1, STEPS.length - 1));
      else if (e.key === "ArrowLeft") setStep((x) => Math.max(x - 1, 0));
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const finish = () => {
    markOnboarded();
    onClose();
  };
  const next = () => (step >= STEPS.length - 1 ? finish() : setStep(step + 1));
  const back = () => setStep(Math.max(0, step - 1));
  const color = s.color ?? AMBER;
  const spotlighting = !!s.target && !!rect;

  const nav = (
    <Nav step={step} total={STEPS.length} onBack={back} onNext={next} onSkip={finish} color={color} />
  );

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 2000 }}>
      <style>{PULSE_CSS}</style>

      {spotlighting ? (
        <>
          {/* click-blocking backdrop (dimming itself comes from the spotlight's box-shadow) */}
          <div style={{ position: "absolute", inset: 0 }} onClick={(e) => e.stopPropagation()} />
          {/* the spotlight cutout */}
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
          <Callout rect={rect!} color={color} title={s.title} body={s.body} nav={nav} />
        </>
      ) : (
        <>
          <div style={{ position: "absolute", inset: 0, background: "rgba(4,8,14,0.82)" }} />
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", padding: 16 }}>
            <div style={centerCard}>
              {s.panel === "welcome" && <Welcome />}
              {s.panel === "keys" && <KeysStep health={health} />}
              {s.panel === "done" && <DoneCard />}
              {!s.panel && (
                <>
                  <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8, color }}>{s.title}</div>
                  <div style={{ color: "#c2cad6", lineHeight: 1.6 }}>{s.body}</div>
                </>
              )}
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
}: {
  step: number;
  total: number;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
  color: string;
}) {
  const last = step === total - 1;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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
        {last ? "Start editing" : step === 0 ? "Take the tour" : "Next"}
      </button>
    </div>
  );
}

function Tool({ icon, name, desc }: { icon: string; name: string; desc: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
      <span style={{ width: 18, textAlign: "center", color: CYAN }}>{icon}</span>
      <b style={{ color: "#e9ecf2", minWidth: 74 }}>{name}</b>
      <span style={{ color: "#9aa4b2" }}>{desc}</span>
    </div>
  );
}

function Welcome() {
  return (
    <div>
      <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>Welcome to {APP_NAME}</div>
      <p style={{ color: "#aeb6c2", lineHeight: 1.55, fontSize: 13.5, margin: "0 0 14px" }}>
        An AI-assisted image editor: select any element, refine the edge, and send <b>only that
        selection</b> to an AI model to replace, restyle, or re-pose it — while the rest of the
        picture stays untouched. This quick tour points out every part of the interface. ~1 minute.
      </p>
      <ul style={{ color: "#9aa4b2", lineHeight: 1.7, fontSize: 12.5, margin: 0, paddingLeft: 18 }}>
        <li><span style={{ color: CYAN }}>Cyan</span> = selection · <span style={{ color: AMBER }}>amber</span> = AI generation.</li>
        <li>Every edit is a re-editable layer — nothing is destructive.</li>
      </ul>
    </div>
  );
}

function KeysStep({ health }: { health: HealthResponse | null }) {
  const [status, setStatus] = useState<SettingsStatus | null>(null);
  const [wavespeed, setWavespeed] = useState("");
  const [anthropic, setAnthropic] = useState("");
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<string | null>(null);

  useEffect(() => {
    getSettings().then(setStatus).catch(() => {});
  }, []);

  const wsSet = !!status?.secrets?.wavespeed_api_key?.set;
  const antSet = !!status?.secrets?.anthropic_api_key?.set;
  const onGpu = !!health?.cuda && !!health?.gpu_name;

  const saveAndTest = async () => {
    const updates: Record<string, string> = {};
    if (wavespeed.trim()) updates.wavespeed_api_key = wavespeed.trim();
    if (anthropic.trim()) updates.anthropic_api_key = anthropic.trim();
    setBusy(true);
    setTest(null);
    try {
      if (Object.keys(updates).length) {
        setStatus(await saveSettings(updates));
        setWavespeed("");
        setAnthropic("");
      }
      await loadModels(true);
      const meta = modelsMeta();
      if (!meta.hasKey) setTest("No WaveSpeed key yet — you can add it later in ⚙ Settings.");
      else if (meta.dynamicError) setTest(`Couldn't reach WaveSpeed: ${meta.dynamicError}`);
      else setTest(`Connected — ${meta.dynamicCount} live image models loaded.`);
    } catch (e) {
      setTest(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Enter your API keys</div>
      <p style={{ color: "#9aa4b2", fontSize: 12.5, lineHeight: 1.5, margin: "0 0 14px" }}>
        Stored locally on this machine, owner-readable only. A <b>WaveSpeed</b> key is needed to
        generate; <b>Anthropic</b> improves prompt synthesis. You can skip and add them later.
      </p>
      <Field label="WaveSpeed API key" placeholder={wsSet ? "•••• set — leave blank to keep" : "wsk-…"} value={wavespeed} onChange={setWavespeed} set={wsSet} />
      <Field label="Anthropic API key (optional)" placeholder={antSet ? "•••• set — leave blank to keep" : "sk-ant-…"} value={anthropic} onChange={setAnthropic} set={antSet} />
      <button onClick={saveAndTest} disabled={busy} style={{ ...primaryBtn, background: AMBER, opacity: busy ? 0.6 : 1 }}>
        {busy ? "Testing…" : "Save & test connection"}
      </button>
      {test && (
        <p style={{ fontSize: 12, marginTop: 10, color: test.startsWith("Connected") ? "#34d399" : "#e0b060" }}>{test}</p>
      )}
      <p style={{ fontSize: 11, color: onGpu || !health?.gpu_present ? "#6b7280" : "#e0b060", marginTop: 12, lineHeight: 1.5 }}>
        Compute: <b style={{ color: onGpu ? "#34d399" : "#cbd5e1" }}>{onGpu ? health?.gpu_name : "CPU"}</b>
        {onGpu ? " — GPU ready." : health?.gpu_present ? " — NVIDIA GPU detected; use the GPU build to activate CUDA." : " — running on CPU."}
      </p>
    </div>
  );
}

function Field({ label, placeholder, value, onChange, set }: { label: string; placeholder: string; value: string; onChange: (v: string) => void; set: boolean }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 12 }}>
      <span style={{ fontSize: 12, color: "#cbd5e1" }}>
        {label} {set && <span style={{ color: "#34d399", fontSize: 11 }}>✓ set</span>}
      </span>
      <input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        style={{ background: "#0d0f12", color: "#e2e8f0", border: "1px solid #2a2f37", borderRadius: 6, padding: "9px 10px", fontSize: 13 }}
      />
    </label>
  );
}

function DoneCard() {
  return (
    <div>
      <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>You're all set 🎉</div>
      <p style={{ color: "#aeb6c2", lineHeight: 1.6, fontSize: 13.5, margin: "0 0 12px" }}>
        The quick loop: <b style={{ color: CYAN }}>Open</b> → <b style={{ color: CYAN }}>Select</b>{" "}
        the area → <b style={{ color: AMBER }}>describe</b> the edit → <b style={{ color: AMBER }}>Generate</b>.
        Reopen this tour any time from <b>⚙ Settings ▸ Show walkthrough</b>.
      </p>
      <ul style={{ color: "#9aa4b2", lineHeight: 1.7, fontSize: 12.5, margin: 0, paddingLeft: 18 }}>
        <li><span style={{ color: CYAN }}>Cyan</span> = selection · <span style={{ color: AMBER }}>amber</span> = AI generation.</li>
        <li>Every edit is a re-editable layer — nothing is destructive.</li>
      </ul>
    </div>
  );
}

const PULSE_CSS = `@keyframes neu-pulse {0%,100%{outline-offset:0}50%{outline-offset:4px}}`;

const centerCard: React.CSSProperties = {
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
