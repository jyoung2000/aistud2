import { useEffect, useMemo, useRef, useState } from "react";
import { COLOR_GENERATION } from "../constants";
import { getModels, loadModels, modelById, modelsMeta, type ModelRefCaps } from "../api/referenceModels";
import { emitMilestone } from "../state/milestones";
import { fireTip } from "../ui/coachmarks";
import {
  ReferenceBlock,
  defaultReferenceState,
  type ReferenceState,
} from "./referenceBlock";
import { ModelCompare, ParadigmBadge } from "./modelCompare";
import { TunedPrompts } from "./tunedPrompts";
import { LoraPanel } from "./loraPanel";
import type { AttachedLora } from "../api/loras";
import { setGenConfig } from "../state/genConfig";

// Minimal "Model & params" step of the inspector pipeline. Stub host so the Reference
// block (M1) and Compare mode (shootout M1) can be built and verified standalone;
// Phases 6–8 replace the stub model list with the real registry and add the prompt /
// params / queue controls and the actual N-way run.
export function InspectorPipeline() {
  const [models, setModels] = useState<ModelRefCaps[]>(getModels());
  const [compareMode, setCompareMode] = useState(false);
  const [modelId, setModelId] = useState(getModels()[0].id);
  const userPickedModel = useRef(false);
  const [hasKey, setHasKey] = useState(true); // optimistic until /models answers
  useEffect(() => {
    loadModels().then((m) => {
      setModels([...m]);
      setHasKey(modelsMeta().hasKey);
      // Default to the first confirmed-slug model — an unverified default would 404 the
      // user's first real-key generation. Don't override an explicit user choice.
      if (!userPickedModel.current) {
        const confirmed = m.find((x) => x.confirmed_slug === true);
        if (confirmed) setModelId(confirmed.id);
      }
    });
  }, []);
  const [comparisonSet, setComparisonSet] = useState<string[]>(() => {
    const m = getModels();
    return [m[0].id, m[Math.min(2, m.length - 1)].id];
  });
  const [intent, setIntent] = useState("");
  const [subject, setSubject] = useState("");
  const [attachedLoras, setAttachedLoras] = useState<AttachedLora[]>([]);

  // The reference block needs one model. In compare mode it follows the first selected
  // model (the "primary"); otherwise the single active model.
  const primaryId = compareMode ? comparisonSet[0] ?? getModels()[0].id : modelId;
  const model = useMemo<ModelRefCaps>(
    () => modelById(primaryId) ?? getModels()[0],
    [primaryId]
  );

  const [refByModel, setRefByModel] = useState<Record<string, ReferenceState>>({});
  const refState = refByModel[primaryId] ?? defaultReferenceState(model);

  // Publish the active model + reference/pose + LoRAs to the shared store so the canvas's
  // Generate action can send them (reference milestone M3). Reference-image files (replace/
  // style) are read to a data URL; the pose role uses the rendered control image directly.
  useEffect(() => {
    const role = model.reference_roles.includes(refState.role) ? refState.role : null;
    const loras = attachedLoras.map((a) => ({ ref: a.ref, weight: a.weight, trigger_words: a.trigger_words }));
    const controlStrength =
      role === "pose" ? refState.poseStrength : role === "style" ? refState.styleStrength : 1;

    const publish = (referencePng: string | null) =>
      setGenConfig({
        modelId: model.id,
        modelLabel: model.label,
        referenceRole: role,
        referencePng,
        controlStrength,
        pose: role === "pose" ? refState.pose : undefined,
        loras,
      });

    if (role === "pose") {
      publish(refState.controlImage ?? null);
    } else if ((role === "replace" || role === "style") && refState.file) {
      const fr = new FileReader();
      fr.onload = () => publish(String(fr.result));
      fr.onerror = () => publish(null);
      fr.readAsDataURL(refState.file);
    } else {
      publish(null);
    }
    if (refState.file || refState.controlImage) {
      emitMilestone("reference");
      fireTip("reference-roles");
    }
  }, [model, refState, attachedLoras]);

  // Publish compare mode + set so the Generate bar can run the shootout (M3).
  useEffect(() => {
    setGenConfig({ compareMode, compareSet: comparisonSet });
    if (compareMode) {
      emitMilestone("compare");
      fireTip("compare");
    }
  }, [compareMode, comparisonSet]);

  // Routing: make `toId` the active/primary model for a role it supports, carrying the
  // reference image and the chosen role across the switch.
  const switchModel = (toId: string, role: string) => {
    const target = modelById(toId);
    if (!target) return;
    const carriedFile = refState.file;
    if (compareMode) {
      setComparisonSet((prev) => [toId, ...prev.filter((x) => x !== toId)]);
    } else {
      setModelId(toId);
    }
    setRefByModel((prev) => ({
      ...prev,
      [toId]: { ...defaultReferenceState(target), role: role as ReferenceState["role"], file: carriedFile },
    }));
  };

  return (
    <aside
      data-tour="inspector"
      style={{
        width: 320,
        flex: "0 0 320px",
        height: "100%",
        overflowY: "auto",
        borderLeft: "1px solid #262a31",
        background: "#101317",
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <div style={{ display: "flex", alignItems: "center" }}>
        <div style={{ fontSize: 11, letterSpacing: 1, color: "#64748b", fontWeight: 700 }}>
          MODEL &amp; PARAMS
        </div>
        <button
          onClick={() => setCompareMode((v) => !v)}
          title="Run the same edit across multiple models"
          style={{
            marginLeft: "auto",
            fontSize: 10.5,
            fontWeight: 700,
            padding: "3px 8px",
            borderRadius: 999,
            cursor: "pointer",
            border: `1px solid ${compareMode ? COLOR_GENERATION : "#2a2f37"}`,
            background: compareMode ? COLOR_GENERATION : "transparent",
            color: compareMode ? "#1a160e" : "#94a3b8",
          }}
        >
          COMPARE
        </button>
      </div>

      {/* deferred key setup (B4): convert at the moment of motivation, never up front */}
      {!hasKey && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 11,
            lineHeight: 1.45,
            color: "#f2c078",
            background: "#2a1e0b",
            border: "1px solid #f2a33c55",
            borderRadius: 6,
            padding: "7px 9px",
          }}
        >
          <span style={{ flex: 1 }}>
            You're in <b>preview mode</b>: edits are simulated. Add a WaveSpeed key to run{" "}
            <b>{model.label}</b> for real.
          </span>
          <button
            onClick={() => window.dispatchEvent(new CustomEvent("neuclip:open-settings"))}
            style={{
              border: "none",
              background: COLOR_GENERATION,
              color: "#1a160e",
              borderRadius: 5,
              padding: "4px 10px",
              cursor: "pointer",
              fontWeight: 700,
              fontSize: 11,
              whiteSpace: "nowrap",
            }}
          >
            Add key
          </button>
        </div>
      )}

      {compareMode ? (
        <ModelCompare set={comparisonSet} onChange={setComparisonSet} />
      ) : (
        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: 11, color: COLOR_GENERATION, fontWeight: 600 }}>Model</span>
          <select
            value={modelId}
            onChange={(e) => {
              userPickedModel.current = true;
              setModelId(e.target.value);
            }}
            style={{
              background: "#15181d",
              color: "#e2e8f0",
              border: "1px solid #2a2f37",
              borderRadius: 6,
              padding: "7px 8px",
              fontSize: 12,
            }}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
                {m.confirmed_slug === false ? " (unverified)" : ""}
              </option>
            ))}
          </select>
          <span
            style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10.5, color: "#5b6470" }}
          >
            <ParadigmBadge paradigm={model.paradigm} />
            {model.reference_roles.length > 0
              ? `reference: ${model.reference_roles.join(" · ")}`
              : "no reference role"}
          </span>
          {model.confirmed_slug === false && (
            <span style={{ fontSize: 10.5, color: COLOR_GENERATION, lineHeight: 1.4 }}>
              ⚠ This model's API endpoint hasn't been verified from its model card yet —
              generation may fail.
            </span>
          )}
        </label>
      )}

      <ReferenceBlock
        model={model}
        value={refState}
        onChange={(next) => setRefByModel((prev) => ({ ...prev, [primaryId]: next }))}
        onSwitchModel={switchModel}
      />

      {model.supports_lora && (
        <LoraPanel model={model} attached={attachedLoras} onAttached={setAttachedLoras} />
      )}

      {compareMode && (
        <>
          <p style={{ margin: 0, fontSize: 10.5, color: "#5b6470", lineHeight: 1.4 }}>
            Reference applies to the primary model (<b>{model.label}</b>) and is held
            identical across the set (fairness contract).
          </p>
          <TunedPrompts
            set={comparisonSet}
            intent={intent}
            subject={subject}
            reference={{ role: refState.role, present: !!refState.file }}
            loraTriggers={attachedLoras.flatMap((a) => a.trigger_words)}
            onIntent={setIntent}
            onSubject={setSubject}
          />
        </>
      )}
    </aside>
  );
}
