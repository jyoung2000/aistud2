import type { AdjustSpec, AdjustType, BlendMode, Layer } from "../canvas/document";

const ADJUSTS: AdjustType[] = ["exposure", "contrast", "saturation", "temperature", "vibrance"];

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
  selectedIds = [],
  thumbs,
  baseThumb,
  onSelect,
  onToggleVisible,
  onOpacity,
  onBlend,
  onDelete,
  onReorder,
  onEdit,
  onAdjust,
  onReroll,
  onGroup,
  onAlign,
  onDuplicateSel,
  onDeleteSel,
  onSelOpacity,
  onFillBehind,
  onFlattenLayer,
}: {
  layers: Layer[];
  activeId: string | null;
  selectedIds?: string[];
  thumbs: Map<string, string>;
  baseThumb: string | null;
  onSelect: (id: string, additive: boolean, range: boolean) => void;
  onToggleVisible: (id: string, alt: boolean) => void;
  onOpacity: (id: string, v: number) => void;
  onBlend: (id: string, m: BlendMode) => void;
  onDelete: (id: string) => void;
  onReorder: (id: string, dir: -1 | 1) => void;
  onEdit: (id: string) => void;
  onAdjust: (id: string, adjust: AdjustSpec) => void;
  onReroll: (id: string) => void;
  onGroup: () => void;
  onAlign: (mode: "left" | "cx" | "right" | "top" | "cy" | "bottom") => void;
  onDuplicateSel: () => void;
  onDeleteSel: () => void;
  onSelOpacity: (v: number) => void;
  onFillBehind: (id: string) => void;
  onFlattenLayer: (id: string) => void;
}) {
  const selCount = selectedIds.length;
  const hasDecomposed = layers.some((l) => l.kind === "decomposed");
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
      <div style={{ padding: "10px 12px 6px", fontSize: 11, letterSpacing: 1, color: "#64748b", fontWeight: 700 }}>
        LAYERS
      </div>

      {selCount > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "0 8px 8px" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
            <span style={{ fontSize: 10, color: "#e9ecf2" }}>{selCount} selected</span>
            <button style={opBtn} onClick={onGroup} title="Group selected layers">Group</button>
            <button style={opBtn} onClick={onDuplicateSel} title="Duplicate">Dup</button>
            <button style={{ ...opBtn, color: "#e5687a" }} onClick={onDeleteSel} title="Delete">Del</button>
          </div>
          {selCount > 1 && (
            <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
              <span style={{ fontSize: 9, color: "#5c6473" }}>align</span>
              {(["left", "cx", "right", "top", "cy", "bottom"] as const).map((mode) => (
                <button key={mode} style={{ ...opBtn, padding: "2px 5px" }} onClick={() => onAlign(mode)} title={`Align ${mode}`}>
                  {mode === "left" ? "⊣" : mode === "cx" ? "↔" : mode === "right" ? "⊢" : mode === "top" ? "⊤" : mode === "cy" ? "↕" : "⊥"}
                </button>
              ))}
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 9, color: "#5c6473" }}>opacity</span>
            <input type="range" min={0} max={1} step={0.01} defaultValue={1} onChange={(e) => onSelOpacity(Number(e.target.value))} style={{ flex: 1, accentColor: "#e9ecf2" }} />
          </div>
        </div>
      )}

      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6, padding: "0 8px 8px" }}>
        {ordered.length === 0 && (
          <div style={{ fontSize: 11, color: "#475569", padding: 8 }}>
            AI edits appear here as re-editable layers.
          </div>
        )}
        {ordered.map((L, ri) => {
          const idx = layers.length - 1 - ri; // position in the array
          const active = L.id === activeId;
          const selected = selectedIds.includes(L.id);
          return (
            <div
              key={L.id}
              onClick={(e) => onSelect(L.id, e.metaKey || e.ctrlKey, e.shiftKey)}
              style={{
                border: `1px solid ${selected ? "#e9ecf2" : active ? "#f59e0b" : "#232830"}`,
                borderRadius: 7,
                background: selected || active ? "#1a160e" : "#14171c",
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
                    onToggleVisible(L.id, e.altKey);
                  }}
                  title={L.visible ? "Hide (Alt-click = solo)" : "Show"}
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
                  <>
                    <button onClick={(e) => { e.stopPropagation(); onReroll(L.id); }} title="Re-roll (new seed, replace in place)" style={smallBtn}>
                      ↻
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); onEdit(L.id); }} title="Edit this layer (load its prompt + region)" style={smallBtn}>
                      edit
                    </button>
                  </>
                )}
                {L.kind === "decomposed" && !/^background/i.test(L.name) && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onFillBehind(L.id); }}
                    title="Fill behind — inpaint the background hole so this subject is freely movable (a generation, has a cost)"
                    style={{ ...smallBtn, color: "#f2a33c", borderColor: "#f2a33c55" }}
                  >
                    fill ⤓
                  </button>
                )}
                {(L.kind === "imported" || L.kind === "ai-edit" || L.kind === "outpaint") && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onFlattenLayer(L.id); }}
                    title="Flatten into base — bake this layer (and everything below it) into the base so AI edits apply to it. Layers above stay independent."
                    style={{ ...smallBtn, color: "#f2a33c", borderColor: "#f2a33c55" }}
                  >
                    flatten ⤵
                  </button>
                )}
                <button onClick={(e) => { e.stopPropagation(); onDelete(L.id); }} title="Delete layer" style={{ ...smallBtn, color: "#ef4444" }}>
                  ✕
                </button>
              </div>

              {L.kind === "adjustment" && L.adjust && (
                <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 2 }}>
                  {ADJUSTS.map((k) => (
                    <label key={k} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 9.5, color: "#94a3b8" }}>
                      <span style={{ width: 64 }}>{k}</span>
                      <input
                        type="range"
                        min={-1}
                        max={1}
                        step={0.02}
                        value={L.adjust!.values[k] ?? 0}
                        onChange={(e) =>
                          onAdjust(L.id, {
                            ...L.adjust!,
                            values: { ...L.adjust!.values, [k]: Number(e.target.value) },
                          })
                        }
                        style={{ flex: 1, accentColor: "#22d3ee" }}
                      />
                    </label>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {hasDecomposed && (
        <div style={{ padding: "6px 10px", fontSize: 9.5, color: "#7d7252", lineHeight: 1.4, borderTop: "1px solid #20242b" }}>
          Auto-separated layers &amp; fill-behind are AI estimates — a smart starting point to
          refine by hand, not guaranteed-perfect cutouts.
        </div>
      )}

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
const opBtn: React.CSSProperties = {
  border: "1px solid #2b313c",
  background: "#1f232b",
  color: "#cbd5e1",
  borderRadius: 4,
  fontSize: 10,
  padding: "3px 7px",
  cursor: "pointer",
};
