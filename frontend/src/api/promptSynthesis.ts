// Prompt intelligence client. The REAL pipeline runs in the sidecar
// (intent → SelectionContext → per-model compiler, `POST /synthesize`) — use
// `synthesizeRemote`. The local stub transform below survives only as the offline
// fallback so the compare pane never blanks when the sidecar is unreachable.

import { baseUrl } from "./sidecar";
import type { ModelRefCaps, ReferenceRole } from "./referenceModels";

// --- sidecar compiler ---------------------------------------------------------------

export const OPERATIONS = [
  "replace", "remove", "add", "restyle", "recolor", "retexture", "pose_change",
  "expression", "background_swap", "text_edit", "relight", "upscale_detail",
] as const;

export interface PromptClause {
  text: string;
  kind: string; // change | preservation | reference | lora | mitigation | scene | quality | ...
  reason: string;
}

export interface EditSpecOut {
  operation: string;
  target_noun: string | null;
  new_content: string | null;
  attributes: string[];
  preserve: string[];
  ambiguities: string[];
  specificity: "low" | "med" | "high";
  raw: string;
  rule: string;
}

export interface CompiledPrompt {
  prompt: string;
  negative_prompt: string | null;
  params_overrides: Record<string, unknown>;
  rationale: string[];
  clauses: PromptClause[];
  send_region_pad: number | null;
  edit_spec: EditSpecOut;
  ambiguities: string[];
  rule_note: string;
  paradigm: string;
  polished?: boolean;
  warnings?: string[];
}

/** Full prompt-intelligence pass in the sidecar: intent + (optional) selection context →
 *  per-model compiled prompt with clause-level rationale. Works with no key and no mask. */
export async function synthesizeRemote(body: {
  model_id: string;
  intent: string;
  subject?: string;
  reference_role?: string;
  loras?: { ref: string; weight: number; trigger_words: string[] }[];
  /** Session id + mask (data URL ok) let the compiler see geometry + scene stats. */
  id?: string;
  mask_png?: string;
  selection_label?: string;
  strength?: "normal" | "strong";
  operation?: string; // one-click parse correction
  medium?: "photo" | "drawn" | "render_cg"; // UI override; else the session's detection
}): Promise<CompiledPrompt> {
  const res = await fetch(`${await baseUrl()}/synthesize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`/synthesize ${res.status}: ${await res.text()}`);
  return (await res.json()) as CompiledPrompt;
}

/** Record a keep/reroll signal for a model+operation (local telemetry → picker badges). */
export async function sendFeedback(modelId: string, kept: boolean, operation?: string): Promise<void> {
  try {
    await fetch(`${await baseUrl()}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model_id: modelId, kept, operation }),
    });
  } catch {
    /* advisory — never blocks the edit */
  }
}

// --- offline stub (fallback only) -----------------------------------------------------

export interface SynthInput {
  /** What the user wants to happen (verbatim, shared across all models). */
  intent: string;
  /** Vision-grounded subject noun phrase (Phase 8). Stubbed/optional here. */
  subject?: string;
  /** Active reference role + whether an image is attached (shared across models). */
  reference?: { role: ReferenceRole; present: boolean };
  /** Attached LoRA trigger words to inject (Tier-1 P9). */
  loraTriggers?: string[];
}

export interface SynthResult {
  slug: string;
  paradigm: string;
  /** The model-tuned prompt. */
  prompt: string;
  /** Which rule fired — surfaced in the UI so the user learns each model's idiom. */
  ruleNote: string;
}

const PRESERVE = "Keep everything outside the selection identical — lighting, composition, and untouched pixels unchanged.";

function subjectOf(input: SynthInput): string {
  return input.subject?.trim() || "the selected subject";
}

/** Reference-role clause appended when a supported reference image is attached. */
function referenceClause(input: SynthInput, model: ModelRefCaps): string | null {
  const ref = input.reference;
  if (!ref?.present || !model.reference_roles.includes(ref.role)) return null;
  const subj = subjectOf(input);
  switch (ref.role) {
    case "replace":
      return "Place the subject from the reference image into the selected region, matching the scene's lighting, perspective, and grain.";
    case "pose":
      return `Keep ${subj} exactly the same — identity, face, and outfit — and change only the pose to match the reference. Attach the pose skeleton as the control image.`;
    case "style":
      return `Restyle ${subj} in the look and palette of the reference; keep the original composition and identity.`;
  }
}

/**
 * Transform one intent into a model-tuned prompt. Synchronous + pure for the stub; the real
 * version is async (sidecar) — `synthesizeAll` returns a Promise to ease that migration.
 */
export function synthesize(input: SynthInput, model: ModelRefCaps): SynthResult {
  const intent = input.intent.trim();
  const subj = subjectOf(input);
  const refClause = referenceClause(input, model);
  const base = { slug: model.id, paradigm: model.paradigm };

  if (!intent && !refClause) {
    return { ...base, prompt: "(enter an intent above)", ruleNote: "awaiting intent" };
  }

  let prompt: string;
  let ruleNote: string;

  switch (model.paradigm) {
    case "inpaint": {
      // Result-DESCRIPTION of the masked area, no imperative verb.
      const desc = intent || "the reference subject in place";
      prompt = `Photorealistic result in the masked region: ${desc}; matched to the surrounding lighting, shadows, and texture, with seamless edges.`;
      ruleNote = "inpaint · rewritten as a result-description of the masked region (no imperative)";
      break;
    }
    case "controlnet": {
      prompt = [
        `Preserve ${subj}'s identity and the scene.`,
        intent ? `Apply: ${intent}.` : "",
        "Follow the attached control image for structure.",
      ]
        .filter(Boolean)
        .join(" ");
      ruleNote = "controlnet · identity-preserving + control image at the chosen strength";
      break;
    }
    case "reference/character": {
      prompt = `Insert the reference character into the selection${intent ? `, ${intent}` : ""}, matching the scene's lighting and perspective; preserve the reference identity.`;
      ruleNote = "reference · identity preservation + reference image in the character slot";
      break;
    }
    case "instruction":
    default: {
      // Imperative + auto-appended preservation clause; light per-model idiom.
      const idiom =
        model.id === "flux-kontext"
          ? `In the selected region, ${intent || "apply the reference"}.`
          : `Edit the selection: ${intent || "apply the reference"}.`;
      prompt = `${idiom} ${PRESERVE}`;
      ruleNote =
        model.id === "flux-kontext"
          ? "instruction · Kontext imperative idiom + preservation clause"
          : "instruction · imperative + auto-appended preservation clause";
      break;
    }
  }

  if (refClause) {
    prompt = `${prompt} ${refClause}`;
    ruleNote = `${ruleNote}; + ${input.reference!.role} reference clause`;
  }

  const triggers = (input.loraTriggers ?? []).filter(Boolean);
  if (triggers.length) {
    prompt = `${triggers.join(", ")}, ${prompt}`;
    ruleNote = `${ruleNote}; injected LoRA trigger(s): ${triggers.join(", ")}`;
  }

  return { ...base, prompt, ruleNote };
}

/** Synthesize one prompt per model from the SAME intent. Async to mirror the future sidecar. */
export async function synthesizeAll(
  input: SynthInput,
  models: ModelRefCaps[]
): Promise<SynthResult[]> {
  return models.map((m) => synthesize(input, m));
}
