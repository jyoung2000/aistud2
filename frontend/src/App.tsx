import { Suspense, lazy, useEffect, useState } from "react";
import { APP_NAME } from "./constants";
import { waitForSidecar } from "./api/sidecar";
import { StatusBar, type SidecarState } from "./panels/statusBar";
import { InspectorPipeline } from "./panels/inspectorPipeline";
import { SettingsModal } from "./panels/settingsModal";
import { CanvasStage } from "./canvas/canvasStage";
import { Toasts } from "./ui/toast";

// lazy — onboarding only matters on first run / on demand; keep it out of the main chunk.
// The gate key is checked inline so the module isn't pulled in just to read localStorage.
const Onboarding = lazy(() =>
  import("./panels/onboarding").then((m) => ({ default: m.Onboarding }))
);
const ONBOARDED_KEY = "neuclip.onboarded.v3"; // must match panels/onboarding.tsx
function hasOnboarded(): boolean {
  try {
    return localStorage.getItem(ONBOARDED_KEY) === "1";
  } catch {
    return true;
  }
}

export default function App() {
  const [state, setState] = useState<SidecarState>({ kind: "connecting" });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [onboardOpen, setOnboardOpen] = useState(false);
  const health = state.kind === "connected" ? state.health : null;

  useEffect(() => {
    let cancelled = false;
    waitForSidecar()
      .then((health) => {
        if (!cancelled) {
          setState({ kind: "connected", health });
          // First run: show the onboarding walkthrough once the sidecar is up.
          if (!hasOnboarded()) setOnboardOpen(true);
        }
      })
      .catch((e) => {
        if (!cancelled) setState({ kind: "error", message: String(e?.message ?? e) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        background: "#0d0f12",
        color: "#e2e8f0",
        font: "13px ui-sans-serif, system-ui, sans-serif",
      }}
    >
      <header
        style={{
          height: 40,
          display: "flex",
          alignItems: "center",
          padding: "0 14px",
          borderBottom: "1px solid #262a31",
          fontWeight: 600,
          letterSpacing: 0.3,
        }}
      >
        {APP_NAME}
        <button
          data-tour="settings"
          onClick={() => setSettingsOpen(true)}
          title="Settings (API keys, compute)"
          style={{
            marginLeft: "auto",
            border: "1px solid #2a2f37",
            background: "transparent",
            color: "#cbd5e1",
            borderRadius: 6,
            padding: "4px 10px",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          ⚙ Settings
        </button>
      </header>

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <CanvasStage />
        <InspectorPipeline />
      </div>

      <StatusBar state={state} />
      <Toasts />

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        health={health}
        onShowWalkthrough={() => {
          setSettingsOpen(false);
          setOnboardOpen(true);
        }}
      />

      {onboardOpen && (
        <Suspense fallback={null}>
          <Onboarding open={onboardOpen} onClose={() => setOnboardOpen(false)} health={health} />
        </Suspense>
      )}
    </div>
  );
}
