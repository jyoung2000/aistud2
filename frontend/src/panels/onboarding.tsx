import { useEffect, useState } from "react";
import { APP_NAME, COLOR_GENERATION, COLOR_SELECTION } from "../constants";
import type { HealthResponse } from "../api/sidecar";
import { getSettings, saveSettings, type SettingsStatus } from "../api/settings";
import { loadModels, modelsMeta } from "../api/referenceModels";

const AMBER = COLOR_GENERATION;
const CYAN = COLOR_SELECTION;
export const ONBOARDED_KEY = "neuclip.onboarded.v2";

/** Mark onboarding complete so it doesn't auto-open again. */
export function markOnboarded() {
  try {
    localStorage.setItem(ONBOARDED_KEY, "1");
  } catch {
    /* private mode — fine, it just re-shows */
  }
}

export function hasOnboarded(): boolean {
  try {
    return localStorage.getItem(ONBOARDED_KEY) === "1";
  } catch {
    return false;
  }
}

type WalkStep = {
  badge: string;
  color: string;
  title: string;
  body: React.ReactNode;
};

const WALK: WalkStep[] = [
  {
    badge: "1",
    color: CYAN,
    title: "Open an image",
    body: (
      <>
        Use <b>File ▸ Open</b> in the top bar (or drop a file on the canvas). On open, the app
        can <b>auto-separate</b> the photo into editable layers (people, background, objects) —
        an AI estimate you refine, not a locked cutout. The base image is <b>never modified</b>.
      </>
    ),
  },
  {
    badge: "2",
    color: CYAN,
    title: "Select what to edit",
    body: (
      <>
        The left <b>tool rail</b> holds the selection tools: <b>Smart-Select</b> (SAM 2 — click
        the subject), <b>Lasso</b> (freehand / polygon / magnetic edge-snap), and the editable{" "}
        <b>Pen</b>. Selections show as <span style={{ color: CYAN }}>cyan marching ants</span> and
        all share one mask — hold <b>Shift</b> to add, <b>Alt</b> to subtract, <b>Shift+Alt</b> to
        intersect. Then <b>Refine</b> softens the edge.
      </>
    ),
  },
  {
    badge: "3",
    color: AMBER,
    title: "Describe the edit",
    body: (
      <>
        The right <b>inspector</b> is the <span style={{ color: AMBER }}>AI side</span> (amber).
        Pick a model, type what you want, and optionally attach a <b>reference image</b> with a
        role (<i>replace / pose / style</i>). Only a padded <b>crop of your selection</b> is sent —
        everything outside stays byte-for-byte identical, then the result is composited back
        through a feathered edge.
      </>
    ),
  },
  {
    badge: "4",
    color: AMBER,
    title: "Compare models (shootout)",
    body: (
      <>
        Toggle <b>Compare</b> to run the same edit across several models at once, each with its own
        tuned prompt, then keep the best. Same selection, reference, and send-region for every
        model — the only variable is the model. Seeds are locked per model for re-runs but are{" "}
        <i>not comparable across models</i>.
      </>
    ),
  },
  {
    badge: "5",
    color: "#e9ecf2",
    title: "Layers, move & finish",
    body: (
      <>
        Every AI edit becomes a re-editable <b>layer</b> (left panel — opacity, blend, re-roll,
        adjustment layers). The <b>Move</b> tool (V) selects and transforms whole layers — shown as
        a <b>solid white box</b>, never cyan ants. When you're done, <b>Export</b> a full PNG or a
        transparent cutout, or <b>Save</b> a <code>.neuclip</code> project to resume later.
      </>
    ),
  },
];

export function Onboarding({
  open,
  onClose,
  health,
}: {
  open: boolean;
  onClose: () => void;
  health: HealthResponse | null;
}) {
  // step 0 = welcome, 1 = keys, 2..(2+WALK.length-1) = walkthrough, last = done
  const [step, setStep] = useState(0);
  const totalSteps = 2 + WALK.length + 1; // welcome + keys + walk + done

  useEffect(() => {
    if (open) setStep(0);
  }, [open]);

  if (!open) return null;

  const finish = () => {
    markOnboarded();
    onClose();
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#000c",
        display: "grid",
        placeItems: "center",
        zIndex: 60,
      }}
    >
      <div
        style={{
          width: 560,
          maxWidth: "94vw",
          maxHeight: "90vh",
          overflowY: "auto",
          background: "#12151a",
          border: "1px solid #2a2f37",
          borderRadius: 14,
          padding: 24,
          color: "#e2e8f0",
          font: "13px ui-sans-serif, system-ui, sans-serif",
          boxShadow: "0 20px 60px #000c",
        }}
      >
        {/* progress dots */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 18 }}>
          {Array.from({ length: totalSteps }).map((_, i) => (
            <div
              key={i}
              style={{
                height: 4,
                flex: 1,
                borderRadius: 2,
                background: i <= step ? AMBER : "#2a2f37",
                transition: "background 120ms",
              }}
            />
          ))}
          <button
            onClick={finish}
            title="Skip setup"
            style={{
              marginLeft: 8,
              border: "none",
              background: "transparent",
              color: "#6b7280",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            Skip
          </button>
        </div>

        {step === 0 && <Welcome />}
        {step === 1 && <KeysStep health={health} />}
        {step >= 2 && step < 2 + WALK.length && <WalkCard s={WALK[step - 2]} />}
        {step === totalSteps - 1 && <DoneCard />}

        {/* nav */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 22 }}>
          {step > 0 && (
            <button onClick={() => setStep((s) => s - 1)} style={ghostBtn}>
              Back
            </button>
          )}
          <div style={{ flex: 1 }} />
          {step < totalSteps - 1 ? (
            <button onClick={() => setStep((s) => s + 1)} style={primaryBtn}>
              {step === 0 ? "Get started" : "Next"}
            </button>
          ) : (
            <button onClick={finish} style={primaryBtn}>
              Start editing
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Welcome() {
  return (
    <div>
      <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>
        Welcome to {APP_NAME}
      </div>
      <p style={{ color: "#aeb6c2", lineHeight: 1.55, fontSize: 13.5, margin: "0 0 14px" }}>
        An AI-assisted image editor: select any element, refine the edge, and send{" "}
        <b>only that selection</b> to a WaveSpeed image model to replace, restyle, or re-pose it —
        while the rest of the picture stays untouched.
      </p>
      <ul style={{ color: "#9aa4b2", lineHeight: 1.7, fontSize: 12.5, margin: 0, paddingLeft: 18 }}>
        <li>Non-destructive layer document — the original is never overwritten.</li>
        <li>SAM 2 / lasso / pen selection with one shared mask.</li>
        <li>Per-model tuned prompts and a multi-model compare mode.</li>
      </ul>
      <p style={{ color: "#6b7280", fontSize: 11.5, marginTop: 14 }}>
        This quick setup enters your API keys and walks through the interface. ~1 minute.
      </p>
    </div>
  );
}

function KeysStep({ health }: { health: HealthResponse | null }) {
  const [status, setStatus] = useState<SettingsStatus | null>(null);
  const [wavespeed, setWavespeed] = useState("");
  const [anthropic, setAnthropic] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [test, setTest] = useState<string | null>(null);

  useEffect(() => {
    getSettings().then(setStatus).catch(() => {});
  }, []);

  const wsSet = !!status?.secrets?.wavespeed_api_key?.set;
  const antSet = !!status?.secrets?.anthropic_api_key?.set;

  const saveAndTest = async () => {
    const updates: Record<string, string> = {};
    if (wavespeed.trim()) updates.wavespeed_api_key = wavespeed.trim();
    if (anthropic.trim()) updates.anthropic_api_key = anthropic.trim();
    setBusy(true);
    setMsg(null);
    setTest(null);
    try {
      if (Object.keys(updates).length) {
        const next = await saveSettings(updates);
        setStatus(next);
        setWavespeed("");
        setAnthropic("");
        setMsg("Saved.");
      }
      // Connection test: refresh the live catalog and report what came back.
      await loadModels(true);
      const meta = modelsMeta();
      if (!meta.hasKey) setTest("No WaveSpeed key set yet — you can add it later in ⚙ Settings.");
      else if (meta.dynamicError) setTest(`Couldn't reach WaveSpeed: ${meta.dynamicError}`);
      else setTest(`Connected — ${meta.dynamicCount} live image-to-image / LoRA models loaded.`);
    } catch (e) {
      setMsg(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const onGpu = !!health?.cuda && !!health?.gpu_name;

  return (
    <div>
      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Enter your API keys</div>
      <p style={{ color: "#9aa4b2", fontSize: 12.5, lineHeight: 1.5, margin: "0 0 16px" }}>
        Keys are stored locally on this machine (owner-readable only) and never leave it except to
        call the service. You need a <b>WaveSpeed</b> key to generate; an <b>Anthropic</b> key
        improves prompt synthesis. You can skip and add them later in <b>⚙ Settings</b>.
      </p>

      <Field
        label="WaveSpeed API key"
        placeholder={wsSet ? "•••• already set — leave blank to keep" : "wsk-…"}
        value={wavespeed}
        onChange={setWavespeed}
        set={wsSet}
      />
      <Field
        label="Anthropic API key (optional)"
        placeholder={antSet ? "•••• already set — leave blank to keep" : "sk-ant-…"}
        value={anthropic}
        onChange={setAnthropic}
        set={antSet}
      />

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 4 }}>
        <button onClick={saveAndTest} disabled={busy} style={{ ...primaryBtn, opacity: busy ? 0.6 : 1 }}>
          {busy ? "Testing…" : "Save & test connection"}
        </button>
        {msg && <span style={{ fontSize: 12, color: "#94a3b8" }}>{msg}</span>}
      </div>

      {test && (
        <p
          style={{
            fontSize: 12,
            marginTop: 12,
            padding: "8px 10px",
            borderRadius: 6,
            background: "#0e1620",
            border: `1px solid ${test.startsWith("Connected") ? "#1f5f45" : "#3a2a12"}`,
            color: test.startsWith("Connected") ? "#34d399" : "#e0b060",
          }}
        >
          {test}
        </p>
      )}

      <p style={{ fontSize: 11, color: onGpu || !health?.gpu_present ? "#6b7280" : "#e0b060", marginTop: 14, lineHeight: 1.5 }}>
        Compute: <b style={{ color: onGpu ? "#34d399" : "#cbd5e1" }}>{onGpu ? health?.gpu_name : "CPU"}</b>
        {onGpu
          ? " — GPU ready."
          : health?.gpu_present
            ? " — NVIDIA GPU detected but this is the CPU build. Download the GPU build (“Neuclip Studio GPU”) and double-click it to activate CUDA — no install."
            : " — running on CPU. The GPU build activates CUDA on double-click on NVIDIA machines."}
      </p>
    </div>
  );
}

function Field({
  label,
  placeholder,
  value,
  onChange,
  set,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  set: boolean;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 14 }}>
      <span style={{ fontSize: 12, color: "#cbd5e1" }}>
        {label}{" "}
        {set && <span style={{ color: "#34d399", fontSize: 11 }}>✓ set</span>}
      </span>
      <input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        style={{
          background: "#0d0f12",
          color: "#e2e8f0",
          border: "1px solid #2a2f37",
          borderRadius: 6,
          padding: "9px 10px",
          fontSize: 13,
        }}
      />
    </label>
  );
}

function WalkCard({ s }: { s: WalkStep }) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <span
          style={{
            width: 26,
            height: 26,
            borderRadius: 8,
            display: "grid",
            placeItems: "center",
            background: s.color,
            color: "#0d0f12",
            fontWeight: 800,
            fontSize: 13,
          }}
        >
          {s.badge}
        </span>
        <div style={{ fontSize: 18, fontWeight: 700 }}>{s.title}</div>
      </div>
      <p style={{ color: "#c2cad6", lineHeight: 1.6, fontSize: 13.5, margin: 0 }}>{s.body}</p>
    </div>
  );
}

function DoneCard() {
  return (
    <div>
      <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>You're all set 🎉</div>
      <p style={{ color: "#aeb6c2", lineHeight: 1.6, fontSize: 13.5, margin: "0 0 12px" }}>
        Open an image to begin. You can reopen this walkthrough any time from{" "}
        <b>⚙ Settings ▸ Show walkthrough</b>, and manage API keys there too.
      </p>
      <ul style={{ color: "#9aa4b2", lineHeight: 1.7, fontSize: 12.5, margin: 0, paddingLeft: 18 }}>
        <li>
          <span style={{ color: CYAN }}>Cyan</span> = selection · <span style={{ color: AMBER }}>amber</span> = AI generation.
        </li>
        <li>The latest WaveSpeed image-to-image &amp; LoRA models load automatically.</li>
        <li>Every edit is a re-editable layer — nothing is destructive.</li>
      </ul>
    </div>
  );
}

const primaryBtn: React.CSSProperties = {
  padding: "9px 18px",
  borderRadius: 7,
  border: "none",
  cursor: "pointer",
  fontWeight: 700,
  color: "#1a160e",
  background: AMBER,
  fontSize: 13,
};
const ghostBtn: React.CSSProperties = {
  padding: "9px 16px",
  borderRadius: 7,
  border: "1px solid #2a2f37",
  cursor: "pointer",
  color: "#cbd5e1",
  background: "transparent",
  fontSize: 13,
};
