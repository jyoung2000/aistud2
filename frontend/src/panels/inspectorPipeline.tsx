import { useMemo, useState } from "react";
import { COLOR_GENERATION } from "../constants";
import { STUB_MODELS, type ModelRefCaps } from "../api/referenceModels";
import {
  ReferenceBlock,
  defaultReferenceState,
  type ReferenceState,
} from "./referenceBlock";

// Minimal "Model & params" step of the inspector pipeline. In M1 this is a stub host so
// the Reference block can be built and verified standalone; Phases 6–8 replace the stub
// model list with the real registry and add the prompt / params / queue controls.
export function InspectorPipeline() {
  const [modelId, setModelId] = useState(STUB_MODELS[0].id);
  const model = useMemo<ModelRefCaps>(
    () => STUB_MODELS.find((m) => m.id === modelId) ?? STUB_MODELS[0],
    [modelId]
  );

  // Reference state is keyed per model so switching models resets to that model's
  // best-supported role (M1 behavior; M2 filters the toggle by capability).
  const [refByModel, setRefByModel] = useState<Record<string, ReferenceState>>({});
  const refState = refByModel[modelId] ?? defaultReferenceState(model);

  return (
    <aside
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
      <div style={{ fontSize: 11, letterSpacing: 1, color: "#64748b", fontWeight: 700 }}>
        MODEL &amp; PARAMS
      </div>

      <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: 11, color: COLOR_GENERATION, fontWeight: 600 }}>Model</span>
        <select
          value={modelId}
          onChange={(e) => setModelId(e.target.value)}
          style={{
            background: "#15181d",
            color: "#e2e8f0",
            border: "1px solid #2a2f37",
            borderRadius: 6,
            padding: "7px 8px",
            fontSize: 12,
          }}
        >
          {STUB_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <span style={{ fontSize: 10.5, color: "#5b6470" }}>
          supports: {model.reference_roles.join(" · ")}
        </span>
      </label>

      <ReferenceBlock
        model={model}
        value={refState}
        onChange={(next) => setRefByModel((prev) => ({ ...prev, [modelId]: next }))}
      />
    </aside>
  );
}
