// One intent -> N tuned prompts (shootout M2).
//
// STUB synthesis: a deterministic, paradigm-aware transform so the comparison view can show
// how each model's prompt differs from the SAME intent. The real synthesis (Phase 8) runs in
// the sidecar (`profiles/synth.py`): vision-grounds the crop, classifies the edit type, then
// applies the model's profile (paradigm transform, style rules, preservation clause,
// constraints). Keep this signature stable so the UI swaps to a sidecar call unchanged.

import type { ModelRefCaps, ReferenceRole } from "./referenceModels";

export interface SynthInput {
  /** What the user wants to happen (verbatim, shared across all models). */
  intent: string;
  /** Vision-grounded subject noun phrase (Phase 8). Stubbed/optional here. */
  subject?: string;
  /** Active reference role + whether an image is attached (shared across models). */
  reference?: { role: ReferenceRole; present: boolean };
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

  return { ...base, prompt, ruleNote };
}

/** Synthesize one prompt per model from the SAME intent. Async to mirror the future sidecar. */
export async function synthesizeAll(
  input: SynthInput,
  models: ModelRefCaps[]
): Promise<SynthResult[]> {
  return models.map((m) => synthesize(input, m));
}
