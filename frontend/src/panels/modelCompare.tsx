import { COLOR_GENERATION } from "../constants";
import {
  MAX_COMPARE,
  STUB_MODELS,
  modelById,
  type ModelRefCaps,
} from "../api/referenceModels";

const AMBER = COLOR_GENERATION;

const PARADIGM_COLOR: Record<string, string> = {
  instruction: "#60a5fa",
  inpaint: "#a78bfa",
  controlnet: "#34d399",
  "reference/character": "#f472b6",
};

export function ParadigmBadge({ paradigm }: { paradigm: string }) {
  const c = PARADIGM_COLOR[paradigm] ?? "#94a3b8";
  return (
    <span
      style={{
        fontSize: 9.5,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: 0.4,
        color: c,
        border: `1px solid ${c}66`,
        borderRadius: 3,
        padding: "1px 5px",
        whiteSpace: "nowrap",
      }}
    >
      {paradigm}
    </span>
  );
}

function fmtCents(c: number): string {
  return `${c.toFixed(1)}¢`;
}

/**
 * Compare mode (shootout) — pick 2..MAX_COMPARE models to run the same edit across.
 * M1: set selection + chips + aggregate cost card. The parallel run is M3.
 */
export function ModelCompare({
  set,
  onChange,
}: {
  set: string[];
  onChange: (next: string[]) => void;
}) {
  const selected = set.map(modelById).filter(Boolean) as ModelRefCaps[];
  const total = selected.reduce((s, m) => s + m.estCostCents, 0);
  const full = set.length >= MAX_COMPARE;
  const breakdown = selected.map((m) => `${m.label}: ~${fmtCents(m.estCostCents)}`).join("\n");

  const toggle = (id: string) => {
    if (set.includes(id)) onChange(set.filter((x) => x !== id));
    else if (!full) onChange([...set, id]);
  };

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* selected chips with quick deselect */}
      {selected.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {selected.map((m) => (
            <span
              key={m.id}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                background: "#1a160e",
                border: `1px solid ${AMBER}55`,
                borderRadius: 999,
                padding: "3px 6px 3px 9px",
                fontSize: 11,
                color: "#f5e9d0",
              }}
            >
              {m.label}
              <button
                onClick={() => toggle(m.id)}
                title="Remove from comparison"
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: "50%",
                  border: "none",
                  background: "#000a",
                  color: "#fff",
                  cursor: "pointer",
                  fontSize: 11,
                  lineHeight: 1,
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* picker — checkable model list */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {STUB_MODELS.map((m) => {
          const on = set.includes(m.id);
          const disabled = !on && full;
          return (
            <label
              key={m.id}
              title={disabled ? `Comparison is capped at ${MAX_COMPARE} models` : undefined}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 8px",
                borderRadius: 6,
                border: `1px solid ${on ? AMBER + "66" : "#2a2f37"}`,
                background: on ? AMBER + "10" : "#15181d",
                cursor: disabled ? "not-allowed" : "pointer",
                opacity: disabled ? 0.45 : 1,
              }}
            >
              <input
                type="checkbox"
                checked={on}
                disabled={disabled}
                onChange={() => toggle(m.id)}
                style={{ accentColor: AMBER }}
              />
              <span style={{ flex: 1, fontSize: 12, color: "#e2e8f0" }}>{m.label}</span>
              <ParadigmBadge paradigm={m.paradigm} />
              <span style={{ fontSize: 10.5, color: "#7d8694", width: 38, textAlign: "right" }}>
                ~{fmtCents(m.estCostCents)}
              </span>
            </label>
          );
        })}
      </div>

      {/* aggregate cost card */}
      <div
        title={breakdown || "Select models to compare"}
        style={{
          border: `1px solid ${AMBER}55`,
          borderRadius: 8,
          background: "#1a160e",
          padding: "10px 12px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 12,
        }}
      >
        <span style={{ color: AMBER, fontWeight: 700 }}>{selected.length}</span>
        <span style={{ color: "#caa86a" }}>
          model{selected.length === 1 ? "" : "s"}
        </span>
        <span style={{ color: "#5b513a" }}>·</span>
        <span style={{ color: "#f5e9d0", fontWeight: 700 }}>~{fmtCents(total)}</span>
        <span style={{ color: "#5b513a" }}>·</span>
        <span style={{ color: "#caa86a" }}>
          {selected.length} generation{selected.length === 1 ? "" : "s"}
        </span>
        <span style={{ marginLeft: "auto", fontSize: 10, color: "#7d7252" }}>hover for breakdown</span>
      </div>

      {selected.length < 2 && (
        <p style={{ margin: 0, fontSize: 10.5, color: "#7d7252", lineHeight: 1.4 }}>
          Pick at least 2 models to compare. Each gets its own tuned prompt; everything else
          is held identical for a fair shootout.
        </p>
      )}
    </section>
  );
}
