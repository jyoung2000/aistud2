import { useEffect, useState, type CSSProperties } from "react";
import { COLOR_GENERATION } from "../constants";
import { modelById, type ModelRefCaps, type ReferenceRole } from "../api/referenceModels";
import {
  OPERATIONS,
  synthesize,
  synthesizeRemote,
  type CompiledPrompt,
  type SynthInput,
} from "../api/promptSynthesis";
import { ParadigmBadge } from "./modelCompare";

const AMBER = COLOR_GENERATION;

const OP_LABEL: Record<string, string> = {
  replace: "replace",
  remove: "remove",
  add: "add",
  restyle: "restyle",
  recolor: "recolor",
  retexture: "material",
  pose_change: "pose",
  expression: "expression",
  background_swap: "background",
  text_edit: "text",
  relight: "lighting",
  upscale_detail: "detail",
};

/** Parse quick-answer options out of an ambiguity like
 *  "'better' — better how? (sharper / brighter / more detailed)". */
function quickAnswers(ambiguity: string): string[] {
  const m = ambiguity.match(/\(([^)]+)\)/);
  if (!m) return [];
  return m[1].split("/").map((s) => s.trim()).filter((s) => s.length > 0 && s.length < 30);
}

/**
 * "Tuned for [model]" disclosure (PI Stage 6) — lives under the Generate prompt. Shows
 * the compiler's output: each clause hoverable with its sourced reason, the parsed
 * operation as a correctable chip, amber ambiguity chips with one-click answers, and an
 * Edit mode whose text is sent verbatim (user override skips the compiler).
 */
export function TunedPromptDisclosure({
  compiled,
  modelLabel,
  override,
  onOverride,
  operation,
  onOperation,
  onQuickAnswer,
  lowChange,
  onStronger,
  busy,
}: {
  compiled: CompiledPrompt | null;
  modelLabel: string;
  override: string | null;
  onOverride: (v: string | null) => void;
  operation: string | null; // user-corrected operation (null = trust the parser)
  onOperation: (op: string | null) => void;
  onQuickAnswer: (answer: string) => void;
  lowChange: boolean;
  onStronger: () => void;
  busy: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  if (!compiled && !lowChange) return null;

  const op = operation ?? compiled?.edit_spec.operation ?? "restyle";
  const corrected = compiled?.edit_spec.rule.startsWith("user-corrected");

  return (
    <div
      data-tour="tuned-prompt"
      style={{
        border: `1px solid ${AMBER}33`,
        background: "#14110a",
        borderRadius: 7,
        padding: "6px 8px",
        display: "flex",
        flexDirection: "column",
        gap: 5,
        fontSize: 11,
      }}
    >
      {compiled && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span style={{ color: AMBER, fontWeight: 700 }}>
              ✨ tuned for {modelLabel}
            </span>
            <select
              value={op}
              onChange={(e) => onOperation(e.target.value === compiled.edit_spec.operation && !corrected ? null : e.target.value)}
              title="What the parser understood — pick a different operation to correct it"
              style={{
                background: "#241d0d",
                color: AMBER,
                border: `1px solid ${AMBER}55`,
                borderRadius: 10,
                fontSize: 10,
                padding: "1px 4px",
                cursor: "pointer",
              }}
            >
              {OPERATIONS.map((o) => (
                <option key={o} value={o}>
                  {OP_LABEL[o] ?? o}
                </option>
              ))}
            </select>
            {override != null && (
              <span style={{ color: "#8a7f63", fontStyle: "italic" }}>edited — sent verbatim</span>
            )}
            <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
              {override == null ? (
                <button
                  onClick={() => {
                    setDraft(compiled.prompt);
                    setEditing(true);
                    onOverride(compiled.prompt);
                  }}
                  style={btnGhost}
                  title="Edit the compiled prompt — your text is sent verbatim (skips the compiler)"
                >
                  ✎ edit
                </button>
              ) : (
                <button onClick={() => { setEditing(false); onOverride(null); }} style={btnGhost} title="Discard your edit and go back to the compiled prompt">
                  ↺ reset
                </button>
              )}
            </span>
          </div>

          {override != null || editing ? (
            <textarea
              value={override ?? draft}
              onChange={(e) => {
                setDraft(e.target.value);
                onOverride(e.target.value);
              }}
              rows={3}
              style={{
                resize: "vertical",
                background: "#0d0f12",
                color: "#e8dcc0",
                border: `1px solid ${AMBER}44`,
                borderRadius: 5,
                padding: "5px 7px",
                fontSize: 11.5,
                lineHeight: 1.45,
                fontFamily: "inherit",
              }}
            />
          ) : (
            <div style={{ color: "#e8dcc0", lineHeight: 1.55, userSelect: "text" }}>
              {compiled.clauses.map((c, i) => (
                <span
                  key={i}
                  title={`${c.kind}: ${c.reason}`}
                  style={{
                    borderBottom: `1px dotted ${c.kind === "change" ? AMBER : "#5b5138"}`,
                    cursor: "help",
                  }}
                >
                  {c.text}
                  {i < compiled.clauses.length - 1 ? " " : ""}
                </span>
              ))}
            </div>
          )}

          {compiled.ambiguities.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
              {compiled.ambiguities.map((a, i) => {
                const answers = quickAnswers(a);
                return (
                  <span key={i} style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
                    <span style={{ color: "#f2c078" }}>? {a.replace(/\s*\([^)]*\)/, "")}</span>
                    {answers.map((ans) => (
                      <button
                        key={ans}
                        onClick={() => onQuickAnswer(ans)}
                        style={{
                          border: `1px solid ${AMBER}66`,
                          background: "#241d0d",
                          color: AMBER,
                          borderRadius: 10,
                          padding: "1px 8px",
                          fontSize: 10,
                          cursor: "pointer",
                        }}
                      >
                        {ans}
                      </button>
                    ))}
                  </span>
                );
              })}
            </div>
          )}

          <details style={{ color: "#8a7c58", fontSize: 10 }}>
            <summary style={{ cursor: "pointer" }}>why this prompt</summary>
            <ul style={{ margin: "4px 0 0", paddingLeft: 16, display: "flex", flexDirection: "column", gap: 2 }}>
              {compiled.rationale.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </details>
        </>
      )}

      {lowChange && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#f2c078" }}>
          <span>⚠ The result barely changed.</span>
          <button
            onClick={onStronger}
            disabled={busy}
            style={{
              border: "none",
              background: AMBER,
              color: "#1a160e",
              borderRadius: 5,
              padding: "2px 9px",
              fontWeight: 700,
              fontSize: 10.5,
              cursor: busy ? "default" : "pointer",
              opacity: busy ? 0.5 : 1,
            }}
          >
            Try a stronger variant
          </button>
        </div>
      )}
    </div>
  );
}

const btnGhost: CSSProperties = {
  border: "none",
  background: "transparent",
  color: "#8a7f63",
  cursor: "pointer",
  fontSize: 10.5,
  padding: 0,
};

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
  loraTriggers,
  onIntent,
  onSubject,
}: {
  set: string[];
  intent: string;
  subject: string;
  reference?: { role: ReferenceRole; present: boolean };
  loraTriggers?: string[];
  onIntent: (v: string) => void;
  onSubject: (v: string) => void;
}) {
  const models = set.map(modelById).filter(Boolean) as ModelRefCaps[];

  // real per-model compiler in the sidecar; the local stub only covers a dead sidecar
  const [results, setResults] = useState<
    { model: ModelRefCaps; slug: string; paradigm: string; prompt: string; ruleNote: string; rationale?: string[] }[]
  >([]);
  useEffect(() => {
    let stale = false;
    const timer = window.setTimeout(async () => {
      const settled = await Promise.all(
        models.map(async (m) => {
          try {
            const r = await synthesizeRemote({
              model_id: m.id,
              intent,
              subject: subject || undefined,
              reference_role: reference?.present ? reference.role : undefined,
              loras: loraTriggers?.length
                ? [{ ref: "ui", weight: 1, trigger_words: loraTriggers }]
                : undefined,
            });
            return {
              model: m,
              slug: m.id,
              paradigm: r.paradigm,
              prompt: r.prompt,
              ruleNote: r.rule_note,
              rationale: r.rationale,
            };
          } catch {
            const input: SynthInput = { intent, subject, reference, loraTriggers };
            return { model: m, ...synthesize(input, m) };
          }
        })
      );
      if (!stale) setResults(settled);
    }, 350);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set.join(","), intent, subject, reference?.role, reference?.present, (loraTriggers ?? []).join(",")]);

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
            {r.rationale && r.rationale.length > 0 && (
              <details style={{ fontSize: 9.5, color: "#8a7c58" }}>
                <summary style={{ cursor: "pointer" }}>why this prompt</summary>
                <ul style={{ margin: "3px 0 0", paddingLeft: 14, display: "flex", flexDirection: "column", gap: 2 }}>
                  {r.rationale.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        ))
      )}

      <p style={{ margin: 0, fontSize: 10, color: "#5b6470", lineHeight: 1.4 }}>
        Same intent, subject, and reference for every model — only the model + its
        profile-compiled prompt change. Expand “why this prompt” to see each clause’s
        sourced reasoning; the rationale differences ARE the models’ documented idioms.
      </p>
    </section>
  );
}
