import { useMemo } from "react";
import { COLOR_GENERATION } from "../constants";
import { modelById, type ModelRefCaps, type ReferenceRole } from "../api/referenceModels";
import { synthesize, type SynthInput } from "../api/promptSynthesis";
import { ParadigmBadge } from "./modelCompare";

const AMBER = COLOR_GENERATION;

/**
 * Shootout M2 — one shared intent synthesized into one tuned prompt per model, shown side
 * by side so the user sees how each paradigm phrases the same goal. The fairness contract
 * holds everything (intent, subject, reference) identical; only model + prompt vary.
 */
export function TunedPrompts({
  set,
  intent,
  subject,
  reference,
  onIntent,
  onSubject,
}: {
  set: string[];
  intent: string;
  subject: string;
  reference?: { role: ReferenceRole; present: boolean };
  onIntent: (v: string) => void;
  onSubject: (v: string) => void;
}) {
  const models = set.map(modelById).filter(Boolean) as ModelRefCaps[];

  const results = useMemo(() => {
    const input: SynthInput = { intent, subject, reference };
    return models.map((m) => ({ model: m, ...synthesize(input, m) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set.join(","), intent, subject, reference?.role, reference?.present]);

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <span style={{ fontSize: 11, color: AMBER, fontWeight: 600 }}>Intent (shared)</span>
        <textarea
          value={intent}
          onChange={(e) => onIntent(e.target.value)}
          placeholder="e.g. make the jacket red leather"
          rows={2}
          style={{
            resize: "vertical",
            background: "#15181d",
            color: "#e2e8f0",
            border: "1px solid #2a2f37",
            borderRadius: 6,
            padding: "7px 8px",
            fontSize: 12,
            fontFamily: "inherit",
          }}
        />
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <span style={{ fontSize: 10.5, color: "#7d8694" }}>
          Subject (optional — Phase 8 fills this from the image)
        </span>
        <input
          value={subject}
          onChange={(e) => onSubject(e.target.value)}
          placeholder="the woman with short black hair"
          style={{
            background: "#15181d",
            color: "#e2e8f0",
            border: "1px solid #2a2f37",
            borderRadius: 6,
            padding: "6px 8px",
            fontSize: 12,
          }}
        />
      </label>

      <div style={{ fontSize: 11, letterSpacing: 0.5, color: "#64748b", fontWeight: 700, marginTop: 2 }}>
        TUNED PROMPTS · ONE PER MODEL
      </div>

      {results.length === 0 ? (
        <p style={{ margin: 0, fontSize: 11, color: "#7d7252" }}>Select models to compare.</p>
      ) : (
        results.map((r) => (
          <div
            key={r.slug}
            style={{
              border: `1px solid ${AMBER}44`,
              background: "#1a160e",
              borderRadius: 8,
              padding: 10,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: "#f5e9d0" }}>
                {r.model.label}
              </span>
              <ParadigmBadge paradigm={r.paradigm} />
            </div>
            <div
              style={{
                fontSize: 12,
                lineHeight: 1.45,
                color: "#e8dcc0",
                background: "#141009",
                border: "1px solid #2a2212",
                borderRadius: 6,
                padding: "7px 8px",
                whiteSpace: "pre-wrap",
                userSelect: "text",
              }}
            >
              {r.prompt}
            </div>
            <div style={{ fontSize: 10, color: "#8a7c58", fontStyle: "italic" }}>
              rule: {r.ruleNote}
            </div>
          </div>
        ))
      )}

      <p style={{ margin: 0, fontSize: 10, color: "#5b6470", lineHeight: 1.4 }}>
        Same intent, subject, and reference for every model — only the model + its tuned
        prompt change. Real synthesis (vision grounding + profile rules) lands in Phase 8;
        editing each prompt + rerun comes in the comparison view (M4).
      </p>
    </section>
  );
}
