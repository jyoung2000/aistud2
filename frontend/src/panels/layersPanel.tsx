import type { BlendMode, Layer } from "../canvas/document";

const BLENDS: BlendMode[] = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "soft-light",
  "darken",
  "lighten",
  "difference",
];

export function LayersPanel({
  layers,
  activeId,
  thumbs,
  baseThumb,
  onSelect,
  onToggleVisible,
  onOpacity,
  onBlend,
  onDelete,
  onReorder,
  onEdit,
}: {
  layers: Layer[];
  activeId: string | null;
  thumbs: Map<string, string>;
  baseThumb: string | null;
  onSelect: (id: string) => void;
  onToggleVisible: (id: string) => void;
  onOpacity: (id: string, v: number) => void;
  onBlend: (id: string, m: BlendMode) => void;
  onDelete: (id: string) => void;
  onReorder: (id: string, dir: -1 | 1) => void;
  onEdit: (id: string) => void;
}) {
  // Compositing order is bottom→top in the array; display top-first.
  const ordered = [...layers].reverse();
  return (
    <aside
      style={{
        width: 240,
        flex: "0 0 240px",
        height: "100%",
        overflowY: "auto",
        borderRight: "1px solid #20242b",
        background: "#0f1216",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ padding: "10px 12px", fontSize: 11, letterSpacing: 1, color: "#64748b", fontWeight: 700 }}>
        LAYERS
      </div>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6, padding: "0 8px 8px" }}>
        {ordered.length === 0 && (
          <div style={{ fontSize: 11, color: "#475569", padding: 8 }}>
            AI edits appear here as re-editable layers.
          </div>
        )}
        {ordered.map((L, ri) => {
          const idx = layers.length - 1 - ri; // position in the array
          const active = L.id === activeId;
          return (
            <div
              key={L.id}
              onClick={() => onSelect(L.id)}
              style={{
                border: `1px solid ${active ? "#f59e0b" : "#232830"}`,
                borderRadius: 7,
                background: active ? "#1a160e" : "#14171c",
                padding: 8,
                display: "flex",
                flexDirection: "column",
                gap: 6,
                cursor: "pointer",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleVisible(L.id);
                  }}
                  title={L.visible ? "Hide" : "Show"}
                  style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 13, color: L.visible ? "#cbd5e1" : "#475569" }}
                >
                  {L.visible ? "👁" : "—"}
                </button>
                <div
                  style={{
                    width: 40,
                    height: 30,
                    borderRadius: 4,
                    border: "1px solid #2a2f37",
                    background: "#0a0c0f center/cover no-repeat",
                    backgroundImage: thumbs.get(L.id) ? `url(${thumbs.get(L.id)})` : undefined,
                    flex: "0 0 auto",
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: "#e2e8f0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {L.name}
                  </div>
                  <div style={{ fontSize: 9.5, color: "#7d8694" }}>{L.kind}</div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <button onClick={(e) => { e.stopPropagation(); onReorder(L.id, 1); }} disabled={idx === layers.length - 1} title="Move up" style={miniBtn}>▲</button>
                  <button onClick={(e) => { e.stopPropagation(); onReorder(L.id, -1); }} disabled={idx === 0} title="Move down" style={miniBtn}>▼</button>
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={L.opacity}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => onOpacity(L.id, Number(e.target.value))}
                  style={{ flex: 1, accentColor: "#f59e0b" }}
                />
                <span style={{ fontSize: 10, color: "#7d8694", width: 30, textAlign: "right" }}>
                  {Math.round(L.opacity * 100)}%
                </span>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <select
                  value={L.blendMode}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => onBlend(L.id, e.target.value as BlendMode)}
                  style={{ flex: 1, background: "#0d0f12", color: "#cbd5e1", border: "1px solid #2a2f37", borderRadius: 4, fontSize: 11, padding: "3px 4px" }}
                >
                  {BLENDS.map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
                {(L.kind === "ai-edit" || L.kind === "outpaint") && (
                  <button onClick={(e) => { e.stopPropagation(); onEdit(L.id); }} title="Edit this layer (load its prompt + region)" style={smallBtn}>
                    edit
                  </button>
                )}
                <button onClick={(e) => { e.stopPropagation(); onDelete(L.id); }} title="Delete layer" style={{ ...smallBtn, color: "#ef4444" }}>
                  ✕
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* base row */}
      <div style={{ borderTop: "1px solid #20242b", padding: 8, display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 13, color: "#475569" }}>🔒</span>
        <div
          style={{
            width: 40,
            height: 30,
            borderRadius: 4,
            border: "1px solid #2a2f37",
            backgroundImage: baseThumb ? `url(${baseThumb})` : undefined,
            backgroundSize: "cover",
          }}
        />
        <div style={{ fontSize: 12, color: "#94a3b8" }}>Base (never modified)</div>
      </div>
    </aside>
  );
}

const miniBtn: React.CSSProperties = {
  border: "1px solid #2a2f37",
  background: "#181c22",
  color: "#94a3b8",
  borderRadius: 3,
  fontSize: 8,
  lineHeight: 1,
  padding: "2px 4px",
  cursor: "pointer",
};
const smallBtn: React.CSSProperties = {
  border: "1px solid #2a2f37",
  background: "#181c22",
  color: "#cbd5e1",
  borderRadius: 4,
  fontSize: 10.5,
  padding: "3px 7px",
  cursor: "pointer",
};
