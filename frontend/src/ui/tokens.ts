// Design tokens — the one place paddings, radii, type sizes, and the color language live.
// Consistency system (redesign A3): identical paddings/radii everywhere is 80% of "clean".
//
// Color language (enforced ruthlessly):
//   cyan  = SELECTION  — every cyan thing selects
//   amber = AI/GENERATION — every amber thing generates
//   blue  = FILE/DOCUMENT actions
// Nothing else uses these hues.

export const SPACE = { xs: 4, s: 8, m: 12, l: 16, xl: 24 } as const;

export const TYPE = {
  label: 10.5,
  body: 12,
  input: 13,
  title: 16,
} as const;

export const RADII = { control: 5, card: 8, modal: 12 } as const;

export const HUE = {
  selection: "#22d3ee", // cyan
  ai: "#f2a33c", // amber (matches COLOR_GENERATION)
  file: "#60a5fa", // blue
} as const;

/** Neutral ramp, dark UI. n0 = page background … n9 = brightest text. */
export const NEUTRAL = {
  n0: "#0a0c0f",
  n1: "#0d1014",
  n2: "#101317",
  n3: "#14171c",
  n4: "#181c22",
  n5: "#20242b",
  n6: "#2a2f37",
  n7: "#5c6473",
  n8: "#94a3b8",
  n9: "#e2e8f0",
} as const;

// --- shared style objects ---------------------------------------------------

export const btn: React.CSSProperties = {
  background: NEUTRAL.n4,
  color: "#cbd5e1",
  border: `1px solid ${NEUTRAL.n6}`,
  borderRadius: RADII.control,
  padding: "4px 9px",
  fontSize: TYPE.body,
  cursor: "pointer",
};

export const iconBtn: React.CSSProperties = {
  ...btn,
  width: 30,
  padding: "4px 0",
  textAlign: "center",
};

/** Accent variant: active/primary treatment in a hue (cyan tools, amber AI). */
export function btnAccent(hue: string, active = true): React.CSSProperties {
  return {
    ...btn,
    background: active ? `${hue}22` : btn.background,
    borderColor: active ? hue : NEUTRAL.n6,
    color: active ? hue : "#cbd5e1",
  };
}

export const disabledStyle: React.CSSProperties = {
  opacity: 0.4,
  cursor: "not-allowed",
};

export const field: React.CSSProperties = {
  background: "#0d0f12",
  color: NEUTRAL.n9,
  border: `1px solid ${NEUTRAL.n6}`,
  borderRadius: RADII.control,
  padding: "6px 8px",
  fontSize: TYPE.input,
};

export const sectionHeader: React.CSSProperties = {
  fontSize: TYPE.label,
  letterSpacing: 1,
  color: "#64748b",
  fontWeight: 700,
  paddingBottom: SPACE.xs,
  borderBottom: `1px solid ${NEUTRAL.n5}`,
  marginBottom: SPACE.s,
};

export const divider: React.CSSProperties = {
  width: 1,
  height: 16,
  background: NEUTRAL.n6,
};
