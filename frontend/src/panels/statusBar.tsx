import type { HealthResponse } from "../api/sidecar";
import { COLOR_SELECTION } from "../constants";
import { emitMilestone } from "../state/milestones";
import { setViewState, useViewState, type ViewMode } from "../state/viewState";

export type SidecarState =
  | { kind: "connecting" }
  | { kind: "connected"; health: HealthResponse }
  | { kind: "error"; message: string };

function deviceBadge(health: HealthResponse): string {
  if (health.cuda && health.gpu_name) {
    // "NVIDIA GeForce RTX 4070" -> "RTX 4070"
    const m = health.gpu_name.match(/RTX\s?\d{3,4}\s?(Ti|SUPER)?/i);
    return m ? m[0].trim() : health.gpu_name;
  }
  return health.torch ? "CPU" : "CPU (no torch)";
}

const VIEW_MODES: { id: ViewMode; label: string; title: string }[] = [
  { id: "normal", label: "Edit", title: "Edit view" },
  { id: "split", label: "A|B", title: "Before/after swipe" },
  { id: "diff", label: "Diff", title: "Changed-pixels diff — proves what the edit touched" },
];

export function StatusBar({ state }: { state: SidecarState }) {
  const view = useViewState();
  let dot = "#888";
  let text = "starting sidecar…";
  let badge: string | null = null;

  if (state.kind === "connecting") {
    dot = "#eab308";
    text = "connecting to sidecar…";
  } else if (state.kind === "connected") {
    dot = "#22c55e";
    text = "sidecar connected";
    badge = deviceBadge(state.health);
  } else if (state.kind === "error") {
    dot = "#ef4444";
    text = `sidecar error: ${state.message}`;
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        height: 28,
        padding: "0 12px",
        background: "#15181d",
        borderTop: "1px solid #262a31",
        color: "#cbd5e1",
        font: "12px/1 ui-monospace, monospace",
      }}
    >
      <span
        style={{
          width: 9,
          height: 9,
          borderRadius: "50%",
          background: dot,
          boxShadow: `0 0 6px ${dot}`,
          flex: "0 0 auto",
        }}
      />
      <span style={{ whiteSpace: "nowrap" }}>{text}</span>

      {view.hasImage && (
        <>
          <span style={{ width: 1, height: 16, background: "#262a31" }} />
          <span data-tour="viewmodes" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            {VIEW_MODES.map((m) => {
              const active = view.viewMode === m.id;
              return (
                <button
                  key={m.id}
                  onClick={() => {
                    setViewState({ viewMode: m.id });
                    if (m.id !== "normal") emitMilestone("abview");
                  }}
                  title={m.title}
                  style={{
                    background: active ? "#22d3ee22" : "#181c22",
                    border: `1px solid ${active ? "#22d3ee" : "#2a2f37"}`,
                    color: active ? "#22d3ee" : "#cbd5e1",
                    borderRadius: 4,
                    padding: "2px 7px",
                    fontSize: 10.5,
                    cursor: "pointer",
                  }}
                >
                  {m.label}
                </button>
              );
            })}
          </span>
          {view.viewMode === "split" && (
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={view.swipe}
              onChange={(e) => setViewState({ swipe: Number(e.target.value) })}
              title="Before/after divider"
              style={{ width: 80, accentColor: "#22d3ee" }}
            />
          )}
          {view.viewMode === "diff" && view.diffPct != null && (
            <span style={{ color: "#e879f9", fontSize: 10.5 }}>changed {view.diffPct.toFixed(1)}%</span>
          )}
          {view.selPct > 0 && (
            <span style={{ fontSize: 10.5, color: "#22d3ee" }}>sel {view.selPct.toFixed(1)}%</span>
          )}
        </>
      )}

      <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 10 }}>
        {view.hasImage && (
          <span style={{ color: "#7d8694", fontSize: 11 }}>
            {view.cursor ? `x ${view.cursor.x.toFixed(0)} y ${view.cursor.y.toFixed(0)}` : "—"}
          </span>
        )}
        {view.hasImage && view.backend && (
          <span
            style={{
              fontSize: 10.5,
              padding: "1px 7px",
              borderRadius: 4,
              border: `1px solid ${view.backend === "sam2" ? "#22c55e" : "#64748b"}`,
              color: view.backend === "sam2" ? "#22c55e" : "#94a3b8",
            }}
            title={view.backend === "sam2" ? "SAM 2 on GPU" : "Classical CPU fallback (no SAM weights)"}
          >
            {view.busy ? "…" : view.backend === "sam2" ? "SAM 2" : "CPU select"}
          </span>
        )}
        {badge && (
          <span
            data-tour="devicebadge"
            style={{
              padding: "2px 8px",
              borderRadius: 4,
              border: `1px solid ${COLOR_SELECTION}`,
              color: COLOR_SELECTION,
              fontWeight: 600,
            }}
          >
            {badge}
          </span>
        )}
      </span>
    </div>
  );
}
