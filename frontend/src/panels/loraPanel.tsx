import { useEffect, useState } from "react";
import { COLOR_GENERATION } from "../constants";
import { listLoras, registerLora, type AttachedLora, type Lora } from "../api/loras";
import type { ModelRefCaps } from "../api/referenceModels";

const A = COLOR_GENERATION;

export function LoraPanel({
  model,
  attached,
  onAttached,
}: {
  model: ModelRefCaps;
  attached: AttachedLora[];
  onAttached: (next: AttachedLora[]) => void;
}) {
  const [lib, setLib] = useState<Lora[]>([]);
  const [form, setForm] = useState({ name: "", ref: "", triggers: "" });
  const max = model.max_loras ?? 0;

  useEffect(() => {
    listLoras().then(setLib).catch(() => setLib([]));
  }, []);

  const attach = (l: Lora) => {
    if (attached.length >= max || attached.some((a) => a.ref === l.ref)) return;
    onAttached([
      ...attached,
      { ref: l.ref, weight: l.weight_default || 0.8, trigger_words: l.trigger_words, name: l.name },
    ]);
  };
  const detach = (ref: string) => onAttached(attached.filter((a) => a.ref !== ref));
  const setWeight = (ref: string, w: number) =>
    onAttached(attached.map((a) => (a.ref === ref ? { ...a, weight: w } : a)));

  const doRegister = async () => {
    if (!form.name.trim() || !form.ref.trim()) return;
    const next = await registerLora({
      name: form.name.trim(),
      ref: form.ref.trim(),
      trigger_words: form.triggers.split(",").map((s) => s.trim()).filter(Boolean),
      compatible_base: model.id,
    });
    setLib(next);
    setForm({ name: "", ref: "", triggers: "" });
  };

  const input: React.CSSProperties = {
    background: "#0d0f12",
    color: "#e2e8f0",
    border: "1px solid #2a2212",
    borderRadius: 5,
    padding: "5px 7px",
    fontSize: 11.5,
  };

  return (
    <section style={{ border: `1px solid ${A}44`, borderRadius: 8, background: "#1a160e", padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "#f5e9d0" }}>
        LoRA stack <span style={{ color: "#9a8b6a", fontWeight: 400 }}>({attached.length}/{max})</span>
      </div>

      {/* attached */}
      {attached.map((a) => (
        <div key={a.ref} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ flex: 1, fontSize: 11, color: "#e8dcc0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {a.name} {a.trigger_words[0] ? <i style={{ color: "#8a7c58" }}>· {a.trigger_words.join(", ")}</i> : null}
          </span>
          <input type="range" min={0} max={1.5} step={0.05} value={a.weight} onChange={(e) => setWeight(a.ref, Number(e.target.value))} style={{ width: 70, accentColor: A }} />
          <span style={{ fontSize: 10, color: "#9a8b6a", width: 26 }}>{a.weight.toFixed(2)}</span>
          <button onClick={() => detach(a.ref)} style={{ border: "none", background: "transparent", color: "#ef4444", cursor: "pointer" }}>✕</button>
        </div>
      ))}

      {/* library */}
      {lib.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {lib.map((l) => {
            const on = attached.some((a) => a.ref === l.ref);
            const full = attached.length >= max;
            return (
              <button
                key={l.id}
                onClick={() => attach(l)}
                disabled={on || full}
                title={`${l.name} — triggers: ${l.trigger_words.join(", ") || "none"}`}
                style={{ fontSize: 10.5, padding: "3px 7px", borderRadius: 999, cursor: on || full ? "default" : "pointer", border: `1px solid ${on ? A : A + "55"}`, background: on ? A + "22" : "transparent", color: on ? A : "#caa86a", opacity: full && !on ? 0.5 : 1 }}
              >
                {on ? "✓ " : "+ "}{l.name}
              </button>
            );
          })}
        </div>
      )}

      {/* register */}
      <details>
        <summary style={{ fontSize: 10.5, color: "#9a8b6a", cursor: "pointer" }}>Register a LoRA…</summary>
        <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 6 }}>
          <input style={input} placeholder="name (e.g. My Character)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input style={input} placeholder="ref — local path or hosted URL/id" value={form.ref} onChange={(e) => setForm({ ...form, ref: e.target.value })} />
          <input style={input} placeholder="trigger words (comma-separated)" value={form.triggers} onChange={(e) => setForm({ ...form, triggers: e.target.value })} />
          <button onClick={doRegister} style={{ alignSelf: "flex-start", padding: "5px 12px", borderRadius: 5, border: "none", background: A, color: "#1a160e", fontWeight: 700, cursor: "pointer", fontSize: 11 }}>
            Add to library
          </button>
        </div>
      </details>
    </section>
  );
}
