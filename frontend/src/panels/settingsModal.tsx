import { useEffect, useState } from "react";
import { COLOR_GENERATION } from "../constants";
import type { HealthResponse } from "../api/sidecar";
import {
  getSettings,
  saveSettings,
  type SecretStatus,
  type SettingsStatus,
} from "../api/settings";
import { loadModels, modelsMeta } from "../api/referenceModels";
import { setTipsDisabled, tipsDisabled } from "../ui/coachmarks";
import { toastSuccess, toast } from "../ui/toast";

const AMBER = COLOR_GENERATION;

export function SettingsModal({
  open,
  onClose,
  health,
  onShowWalkthrough,
}: {
  open: boolean;
  onClose: () => void;
  health: HealthResponse | null;
  onShowWalkthrough?: () => void;
}) {
  const [status, setStatus] = useState<SettingsStatus | null>(null);
  const [wavespeed, setWavespeed] = useState("");
  const [anthropic, setAnthropic] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setMsg(null);
    setWavespeed("");
    setAnthropic("");
    getSettings()
      .then(setStatus)
      .catch((e) => setMsg(String(e?.message ?? e)));
  }, [open]);

  if (!open) return null;

  const save = async () => {
    const updates: Record<string, string> = {};
    if (wavespeed.trim()) updates.wavespeed_api_key = wavespeed.trim();
    if (anthropic.trim()) updates.anthropic_api_key = anthropic.trim();
    if (Object.keys(updates).length === 0) {
      setMsg("Nothing to save — enter a key.");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const next = await saveSettings(updates);
      setStatus(next);
      setWavespeed("");
      setAnthropic("");
      setMsg("Saved.");
      // key just landed → refresh the model list and celebrate going live (B4)
      if (updates.wavespeed_api_key) {
        await loadModels(true);
        const meta = modelsMeta();
        if (meta.hasKey && !meta.dynamicError) {
          toastSuccess(`Live — ${meta.dynamicCount} models available`);
        } else if (meta.dynamicError) {
          toast(`Key saved, but the model list didn't refresh: ${meta.dynamicError}`, "info");
        }
      }
    } catch (e) {
      setMsg(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "#000a",
        display: "grid",
        placeItems: "center",
        zIndex: 50,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 460,
          maxWidth: "92vw",
          maxHeight: "88vh",
          overflowY: "auto",
          background: "#12151a",
          border: "1px solid #2a2f37",
          borderRadius: 12,
          padding: 20,
          color: "#e2e8f0",
          font: "13px ui-sans-serif, system-ui, sans-serif",
          boxShadow: "0 12px 40px #000a",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", marginBottom: 14 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Settings</h2>
          <button
            onClick={onClose}
            style={{
              marginLeft: "auto",
              border: "none",
              background: "transparent",
              color: "#94a3b8",
              fontSize: 20,
              cursor: "pointer",
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        {/* API keys */}
        <div style={{ fontSize: 11, letterSpacing: 1, color: AMBER, fontWeight: 700 }}>
          API KEYS
        </div>
        <p style={{ fontSize: 11, color: "#7d8694", margin: "6px 0 12px", lineHeight: 1.4 }}>
          Stored locally in your user config folder (~/.neuclip). On macOS/Linux the file is
          restricted to your user account (chmod 600); on Windows it relies on your user
          profile's folder permissions. Leave blank to keep the current value. An environment
          variable is used as a fallback.
        </p>

        <KeyField
          label="WaveSpeed API key"
          placeholder="wsk-…"
          value={wavespeed}
          onChange={setWavespeed}
          status={status?.secrets?.wavespeed_api_key}
        />
        <KeyField
          label="Anthropic API key (prompt synthesis)"
          placeholder="sk-ant-…"
          value={anthropic}
          onChange={setAnthropic}
          status={status?.secrets?.anthropic_api_key}
        />

        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 6 }}>
          <button
            onClick={save}
            disabled={busy}
            style={{
              padding: "8px 16px",
              borderRadius: 6,
              border: "none",
              cursor: busy ? "default" : "pointer",
              fontWeight: 700,
              color: "#1a160e",
              background: AMBER,
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? "Saving…" : "Save"}
          </button>
          {msg && <span style={{ fontSize: 12, color: "#94a3b8" }}>{msg}</span>}
        </div>

        {status && (
          <p style={{ fontSize: 10.5, color: "#5b6470", marginTop: 10, wordBreak: "break-all" }}>
            config: {status.config_path}
          </p>
        )}

        {/* Live models */}
        <div style={{ height: 1, background: "#23282f", margin: "16px 0" }} />
        <div style={{ fontSize: 11, letterSpacing: 1, color: AMBER, fontWeight: 700 }}>
          WAVESPEED MODELS
        </div>
        <ModelsInfo />

        {/* Help */}
        {onShowWalkthrough && (
          <>
            <div style={{ height: 1, background: "#23282f", margin: "16px 0" }} />
            <div style={{ fontSize: 11, letterSpacing: 1, color: "#64748b", fontWeight: 700 }}>
              HELP
            </div>
            <button
              onClick={onShowWalkthrough}
              style={{
                marginTop: 8,
                padding: "7px 14px",
                borderRadius: 6,
                border: "1px solid #2a2f37",
                background: "transparent",
                color: "#cbd5e1",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              Show walkthrough
            </button>
            <TipsToggle />
          </>
        )}

        {/* Device */}
        <div style={{ height: 1, background: "#23282f", margin: "16px 0" }} />
        <div style={{ fontSize: 11, letterSpacing: 1, color: "#64748b", fontWeight: 700 }}>
          COMPUTE
        </div>
        <DeviceInfo health={health} />
      </div>
    </div>
  );
}

function KeyField({
  label,
  placeholder,
  value,
  onChange,
  status,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  status?: SecretStatus;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 12 }}>
      <span style={{ fontSize: 12, color: "#cbd5e1" }}>{label}</span>
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
          padding: "8px 10px",
          fontSize: 13,
        }}
      />
      <span style={{ fontSize: 10.5, color: status?.set ? "#34d399" : "#7d8694" }}>
        {status?.set
          ? `set (${status.source}${status.hint ? `, ${status.hint}` : ""})`
          : "not set"}
      </span>
    </label>
  );
}

function TipsToggle() {
  const [disabled, setDisabled] = useState(tipsDisabled());
  return (
    <label
      style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 10, fontSize: 12, color: "#cbd5e1", cursor: "pointer" }}
      title="One-time hints that appear the first time you use a feature"
    >
      <input
        type="checkbox"
        checked={!disabled}
        onChange={(e) => {
          const on = e.target.checked;
          setDisabled(!on);
          setTipsDisabled(!on);
        }}
        style={{ accentColor: "#38bdf8" }}
      />
      Show one-time tips
    </label>
  );
}

function ModelsInfo() {
  const [meta, setMeta] = useState(modelsMeta());
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    setBusy(true);
    try {
      await loadModels(true);
      setMeta({ ...modelsMeta() });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.5 }}>
      <p style={{ color: "#9aa4b2", margin: "0 0 8px" }}>
        The latest image-to-image and image-to-image&nbsp;LoRA models are pulled live from your
        WaveSpeed account (a WaveSpeed key is required). Curated models are always available.
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button
          onClick={refresh}
          disabled={busy}
          style={{
            padding: "6px 12px",
            borderRadius: 6,
            border: "1px solid #2a2f37",
            background: "transparent",
            color: "#cbd5e1",
            cursor: busy ? "default" : "pointer",
            fontSize: 12,
            opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? "Refreshing…" : "Refresh model list"}
        </button>
        <span style={{ fontSize: 11.5, color: meta.dynamicError ? "#e0b060" : "#7d8694" }}>
          {!meta.hasKey
            ? "no key set"
            : meta.dynamicError
              ? `error: ${meta.dynamicError}`
              : `${meta.dynamicCount} live model${meta.dynamicCount === 1 ? "" : "s"} loaded`}
        </span>
      </div>
    </div>
  );
}

function DeviceInfo({ health }: { health: HealthResponse | null }) {
  if (!health) return <p style={{ fontSize: 12, color: "#7d8694" }}>connecting…</p>;
  const onGpu = health.cuda && !!health.gpu_name;
  return (
    <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.5 }}>
      <div>
        Device:{" "}
        <b style={{ color: onGpu ? "#34d399" : "#e2e8f0" }}>
          {onGpu ? health.gpu_name : "CPU"}
        </b>
        {health.torch_version ? ` · torch ${health.torch_version}` : " · torch not installed"}
      </div>
      {!onGpu && health.gpu_present && (
        <p style={{ fontSize: 11, color: "#e0b060", marginTop: 6, lineHeight: 1.5 }}>
          An NVIDIA GPU was detected but this is the <b>CPU build</b>. Download the{" "}
          <b>GPU build</b> (<code>Neuclip Studio GPU</code>) and double-click it — CUDA activates
          automatically, no install. Alternatively, launch via <b>Open Neuclip Studio</b>.
        </p>
      )}
      {!onGpu && !health.gpu_present && (
        <p style={{ fontSize: 11, color: "#9aa4b2", marginTop: 6, lineHeight: 1.5 }}>
          No NVIDIA GPU detected — running on CPU. On an NVIDIA machine, the <b>GPU build</b> of
          the app uses CUDA on double-click (no install); the small standalone <code>.exe</code>{" "}
          is CPU-only.
        </p>
      )}
    </div>
  );
}
