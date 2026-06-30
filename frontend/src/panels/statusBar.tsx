import type { HealthResponse } from "../api/sidecar";
import { COLOR_SELECTION } from "../constants";

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

export function StatusBar({ state }: { state: SidecarState }) {
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
        }}
      />
      <span>{text}</span>
      {badge && (
        <span
          style={{
            marginLeft: "auto",
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
    </div>
  );
}
