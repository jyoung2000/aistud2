import { useEffect, useState } from "react";
import { APP_NAME } from "./constants";
import { waitForSidecar } from "./api/sidecar";
import { StatusBar, type SidecarState } from "./panels/statusBar";

export default function App() {
  const [state, setState] = useState<SidecarState>({ kind: "connecting" });

  useEffect(() => {
    let cancelled = false;
    waitForSidecar()
      .then((health) => {
        if (!cancelled) setState({ kind: "connected", health });
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
      </header>

      <main
        style={{
          flex: 1,
          display: "grid",
          placeItems: "center",
          color: "#64748b",
        }}
      >
        {state.kind === "connected" ? (
          <div style={{ textAlign: "center", lineHeight: 1.6 }}>
            <div>Phase 0 — shell &amp; handshake ✓</div>
            <div style={{ fontSize: 12 }}>
              device: <b style={{ color: "#e2e8f0" }}>{state.health.device}</b>
              {state.health.gpu_name ? ` · ${state.health.gpu_name}` : ""}
            </div>
            <div style={{ fontSize: 11, marginTop: 8, color: "#475569" }}>
              Canvas arrives in Phase 1.
            </div>
          </div>
        ) : state.kind === "error" ? (
          <div style={{ color: "#ef4444" }}>{state.message}</div>
        ) : (
          <div>starting…</div>
        )}
      </main>

      <StatusBar state={state} />
    </div>
  );
}
