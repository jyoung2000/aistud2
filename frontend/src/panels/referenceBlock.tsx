import { useEffect, useRef, useState } from "react";
import { COLOR_GENERATION } from "../constants";
import {
  ROLE_BLURB,
  ROLE_LABELS,
  defaultRoleFor,
  findModelForRole,
  type ModelRefCaps,
  type ReferenceRole,
} from "../api/referenceModels";

const AMBER = COLOR_GENERATION;
const ROLES: ReferenceRole[] = ["replace", "pose", "style"];

/** Reference-image inputs the Edit pipeline consumes (lifted into the generate call
 *  in M3+). Kept role-agnostic so adding roles is additive. */
export interface ReferenceState {
  file: File | null;
  role: ReferenceRole;
  // replace
  blendWithScene: boolean;
  // pose
  poseStrength: number; // 0..1 (loose -> strict)
  preserve: { face: boolean; hair: boolean; outfit: boolean; background: boolean };
  // style
  styleStrength: number; // 0..1
}

export function defaultReferenceState(model: ModelRefCaps): ReferenceState {
  return {
    file: null,
    role: defaultRoleFor(model),
    blendWithScene: true,
    poseStrength: 0.75,
    preserve: { face: true, hair: true, outfit: true, background: true },
    styleStrength: 0.6,
  };
}

export function ReferenceBlock({
  model,
  value,
  onChange,
  onSwitchModel,
}: {
  model: ModelRefCaps;
  value: ReferenceState;
  onChange: (next: ReferenceState) => void;
  /** Route to a model that supports a role the active model can't do. */
  onSwitchModel?: (modelId: string, role: ReferenceRole) => void;
}) {
  const set = (patch: Partial<ReferenceState>) => onChange({ ...value, ...patch });
  const noReference = model.reference_roles.length === 0;
  const supported = model.reference_roles.includes(value.role);

  return (
    <section
      style={{
        border: `1px solid ${AMBER}55`,
        borderRadius: 8,
        background: "#1a160e",
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <Header />

      {noReference ? (
        <NoReferenceNote model={model} />
      ) : (
        <>
          <DropZone file={value.file} onFile={(file) => set({ file })} />
          <RoleToggle
            role={value.role}
            supported={model.reference_roles}
            onRole={(role) => set({ role })}
          />
          <p style={{ margin: 0, fontSize: 11, color: "#9a8b6a", lineHeight: 1.4 }}>
            {ROLE_BLURB[value.role]}
          </p>
          {supported ? (
            <RoleControls model={model} value={value} set={set} />
          ) : (
            <SwitchNotice model={model} role={value.role} onSwitch={onSwitchModel} />
          )}
        </>
      )}
    </section>
  );
}

function Header() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: 2,
          background: AMBER,
          boxShadow: `0 0 6px ${AMBER}`,
        }}
      />
      <span style={{ fontWeight: 600, fontSize: 12, color: "#f5e9d0" }}>
        Reference image
      </span>
    </div>
  );
}

function DropZone({ file, onFile }: { file: File | null; onFile: (f: File | null) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [over, setOver] = useState(false);

  useEffect(() => {
    if (!file) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  const pick = (files: FileList | null) => {
    const f = files?.[0];
    if (f && f.type.startsWith("image/")) onFile(f);
  };

  return (
    <div
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        pick(e.dataTransfer.files);
      }}
      style={{
        position: "relative",
        height: 132,
        borderRadius: 6,
        border: `1.5px dashed ${over ? AMBER : AMBER + "66"}`,
        background: over ? AMBER + "14" : "#141009",
        display: "grid",
        placeItems: "center",
        cursor: "pointer",
        overflow: "hidden",
        textAlign: "center",
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => pick(e.target.files)}
      />
      {url ? (
        <>
          <img
            src={url}
            alt="reference"
            style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
          />
          <button
            onClick={(e) => {
              e.stopPropagation();
              onFile(null);
            }}
            title="Remove reference"
            style={{
              position: "absolute",
              top: 6,
              right: 6,
              width: 22,
              height: 22,
              borderRadius: "50%",
              border: "none",
              background: "#000a",
              color: "#fff",
              cursor: "pointer",
              fontSize: 13,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </>
      ) : (
        <div style={{ color: "#9a8b6a", fontSize: 12, padding: 12 }}>
          <div style={{ fontSize: 22, marginBottom: 4 }}>⤓</div>
          Drop a reference image
          <div style={{ fontSize: 11, color: "#6b6147", marginTop: 2 }}>or click to browse</div>
        </div>
      )}
    </div>
  );
}

function RoleToggle({
  role,
  supported,
  onRole,
}: {
  role: ReferenceRole;
  supported: ReferenceRole[];
  onRole: (r: ReferenceRole) => void;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(3, 1fr)",
        gap: 4,
        background: "#141009",
        borderRadius: 6,
        padding: 3,
      }}
    >
      {ROLES.map((r) => {
        const active = r === role;
        const ok = supported.includes(r);
        return (
          <button
            key={r}
            onClick={() => onRole(r)}
            title={ok ? undefined : "Not supported by this model — pick to switch models"}
            style={{
              position: "relative",
              padding: "6px 4px",
              borderRadius: 4,
              border: active && !ok ? "1px dashed #ef9a4a" : "none",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: active ? 700 : 500,
              color: active ? "#1a160e" : ok ? "#caa86a" : "#6b6147",
              background: active ? AMBER : "transparent",
              opacity: ok || active ? 1 : 0.55,
            }}
          >
            {ROLE_LABELS[r]}
            {!ok && (
              <span
                style={{ marginLeft: 4, fontSize: 9, color: active ? "#5b3a00" : "#7d6a3a" }}
              >
                ◌
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function SwitchNotice({
  model,
  role,
  onSwitch,
}: {
  model: ModelRefCaps;
  role: ReferenceRole;
  onSwitch?: (modelId: string, role: ReferenceRole) => void;
}) {
  const target = findModelForRole(role);
  return (
    <div
      style={{
        border: "1px solid #ef9a4a66",
        background: "#241a0c",
        borderRadius: 6,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        fontSize: 11.5,
        color: "#e8d6b0",
        lineHeight: 1.4,
      }}
    >
      <span>
        <b>{model.label}</b> can't do <b>{ROLE_LABELS[role]}</b>.
      </span>
      {target ? (
        <button
          onClick={() => onSwitch?.(target.id, role)}
          style={{
            alignSelf: "flex-start",
            padding: "5px 10px",
            borderRadius: 5,
            border: "none",
            cursor: "pointer",
            fontSize: 11,
            fontWeight: 700,
            color: "#1a160e",
            background: "#ef9a4a",
          }}
        >
          Switch to {target.label} →
        </button>
      ) : (
        <span style={{ color: "#b9a884" }}>No installed model supports this role.</span>
      )}
    </div>
  );
}

function NoReferenceNote({ model }: { model: ModelRefCaps }) {
  return (
    <div style={{ fontSize: 11.5, color: "#9a8b6a", lineHeight: 1.45 }}>
      <b>{model.label}</b> ({model.paradigm}) takes no reference image — it edits from the
      selection and prompt alone.
    </div>
  );
}

function RoleControls({
  model,
  value,
  set,
}: {
  model: ModelRefCaps;
  value: ReferenceState;
  set: (patch: Partial<ReferenceState>) => void;
}) {
  if (value.role === "replace") {
    return (
      <Field label="Blend with scene">
        <Checkbox
          checked={value.blendWithScene}
          onChange={(blendWithScene) => set({ blendWithScene })}
          label="Match lighting / perspective"
        />
      </Field>
    );
  }

  if (value.role === "pose") {
    const input = model.reference_inputs.pose;
    return (
      <>
        <Field label={`Pose strength · ${Math.round(value.poseStrength * 100)}%`}>
          <Slider
            value={value.poseStrength}
            onChange={(poseStrength) => set({ poseStrength })}
            leftLabel="loose"
            rightLabel="strict"
          />
        </Field>
        <Field label="Skeleton preview">
          <SkeletonStub />
        </Field>
        <Field label="Preserve from original">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            {(["face", "hair", "outfit", "background"] as const).map((k) => (
              <Checkbox
                key={k}
                checked={value.preserve[k]}
                onChange={(v) => set({ preserve: { ...value.preserve, [k]: v } })}
                label={`Keep ${k}`}
              />
            ))}
          </div>
        </Field>
        <Note>
          control input: <b>{input ?? "—"}</b> · pose edits send the full subject (M5 cost
          card)
        </Note>
      </>
    );
  }

  // style
  return (
    <Field label={`Style strength · ${Math.round(value.styleStrength * 100)}%`}>
      <Slider
        value={value.styleStrength}
        onChange={(styleStrength) => set({ styleStrength })}
        leftLabel="subtle"
        rightLabel="strong"
      />
    </Field>
  );
}

// --- small controls ---

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 11, color: "#caa86a", fontWeight: 600 }}>{label}</span>
      {children}
    </div>
  );
}

function Slider({
  value,
  onChange,
  leftLabel,
  rightLabel,
}: {
  value: number;
  onChange: (v: number) => void;
  leftLabel: string;
  rightLabel: string;
}) {
  return (
    <div>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: "100%", accentColor: AMBER }}
      />
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#6b6147" }}>
        <span>{leftLabel}</span>
        <span>{rightLabel}</span>
      </div>
    </div>
  );
}

function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#c9bfa6", cursor: "pointer" }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ accentColor: AMBER }}
      />
      {label}
    </label>
  );
}

function SkeletonStub() {
  return (
    <div
      style={{
        height: 92,
        borderRadius: 6,
        border: `1px dashed ${AMBER}44`,
        background:
          "repeating-linear-gradient(45deg, #141009, #141009 8px, #17120a 8px, #17120a 16px)",
        display: "grid",
        placeItems: "center",
        color: "#6b6147",
        fontSize: 11,
      }}
    >
      DWpose skeleton preview — wired in M4
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10.5, color: "#7d7252", lineHeight: 1.4 }}>{children}</div>
  );
}
