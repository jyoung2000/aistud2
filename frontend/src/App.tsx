import { Suspense, lazy, useEffect, useState } from "react";
import { APP_NAME } from "./constants";
import { waitForSidecar } from "./api/sidecar";
import { StatusBar, type SidecarState } from "./panels/statusBar";
import { InspectorPipeline } from "./panels/inspectorPipeline";
import { SettingsModal } from "./panels/settingsModal";
import { CanvasStage } from "./canvas/canvasStage";
import { Toasts } from "./ui/toast";
import { HelpMenu } from "./panels/help";
import { Tutorial } from "./panels/tutorial";
import { CoachMarks, fireTip } from "./ui/coachmarks";
import { SpotlightHost } from "./ui/spotlight";

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
  const [onboardMode, setOnboardMode] = useState<"welcome" | "tour">("welcome");
  const health = state.kind === "connected" ? state.health : null;

  useEffect(() => {
    let cancelled = false;
    waitForSidecar()
      .then((health) => {
        if (!cancelled) {
          setState({ kind: "connected", health });
          // First run: the one-screen welcome → guided first edit (learn by doing).
          if (!hasOnboarded()) {
            setOnboardMode("welcome");
            setOnboardOpen(true);
          }
          // CPU build on a machine with an idle NVIDIA GPU → one-time nudge (coach mark)
          if (health.gpu_present && !health.cuda) {
            window.setTimeout(() => fireTip("gpu-idle"), 4000);
          }
        }
      })
      .catch((e) => {
        if (!cancelled) setState({ kind: "error", message: String(e?.message ?? e) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // deferred key setup (B4): the inspector banner asks to open Settings at the moment a
  // key matters — decoupled via an event so panels don't need App plumbing.
  useEffect(() => {
    const openSettings = () => setSettingsOpen(true);
    window.addEventListener("neuclip:open-settings", openSettings);
    return () => window.removeEventListener("neuclip:open-settings", openSettings);
  }, []);

  const showTour = () => {
    setOnboardMode("tour");
    setOnboardOpen(true);
  };

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
          gap: 8,
          padding: "0 14px",
          borderBottom: "1px solid #262a31",
          fontWeight: 600,
          letterSpacing: 0.3,
        }}
      >
        {APP_NAME}
        <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8, fontWeight: 400 }}>
          <HelpMenu onShowTour={showTour} />
          <button
            data-tour="settings"
            onClick={() => setSettingsOpen(true)}
            title="Settings — API keys, compute, model list"
            style={{
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
        </span>
      </header>

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <CanvasStage />
        <InspectorPipeline />
      </div>

      <StatusBar state={state} />
      <Toasts />
      <Tutorial onTour={showTour} />
      <CoachMarks />
      <SpotlightHost />

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        health={health}
        onShowWalkthrough={() => {
          setSettingsOpen(false);
          showTour();
        }}
      />

      {onboardOpen && (
        <Suspense fallback={null}>
          <Onboarding
            open={onboardOpen}
            onClose={() => setOnboardOpen(false)}
            health={health}
            mode={onboardMode}
          />
        </Suspense>
      )}
    </div>
  );
}
