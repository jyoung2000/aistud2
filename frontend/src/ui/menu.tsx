// Compact dropdown menu system (File / Image menus, Photoshop-style). Hand-rolled — no
// component libraries (project constraint). A Menu is a button that opens an absolutely
// positioned popover; it closes on outside click, Esc, or when a MenuItem fires.
import { createContext, useContext, useEffect, useRef, useState } from "react";

const MenuClose = createContext<() => void>(() => {});

export function Menu({
  label,
  children,
  width = 230,
}: {
  label: string;
  children: React.ReactNode;
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          background: open ? "#1d222a" : "#181c22",
          color: "#cbd5e1",
          border: `1px solid ${open ? "#3a414d" : "#2a2f37"}`,
          borderRadius: 5,
          padding: "3px 10px",
          fontSize: 11.5,
          cursor: "pointer",
        }}
      >
        {label} <span style={{ fontSize: 8, opacity: 0.7 }}>▾</span>
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            zIndex: 1000,
            minWidth: width,
            background: "#14171c",
            border: "1px solid #2f3540",
            borderRadius: 8,
            padding: 5,
            display: "flex",
            flexDirection: "column",
            gap: 1,
            boxShadow: "0 10px 28px #000a",
          }}
        >
          <MenuClose.Provider value={() => setOpen(false)}>{children}</MenuClose.Provider>
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  label,
  hint,
  disabled,
  accent,
  onClick,
}: {
  label: string;
  hint?: string; // right-aligned shortcut / note
  disabled?: boolean;
  accent?: string; // text color override (e.g. amber for AI actions)
  onClick: () => void;
}) {
  const close = useContext(MenuClose);
  const [hover, setHover] = useState(false);
  return (
    <button
      disabled={disabled}
      onClick={() => {
        close();
        onClick();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        textAlign: "left",
        border: "none",
        borderRadius: 5,
        background: hover && !disabled ? "#20262f" : "transparent",
        color: disabled ? "#4a5260" : accent ?? "#d7dee8",
        padding: "6px 9px",
        fontSize: 12,
        cursor: disabled ? "default" : "pointer",
      }}
    >
      <span style={{ flex: 1 }}>{label}</span>
      {hint && <span style={{ fontSize: 10, color: "#5c6473" }}>{hint}</span>}
    </button>
  );
}

/** A non-closing row for embedded controls (sliders, selects) inside a menu. */
export function MenuRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "5px 9px",
        fontSize: 11,
        color: "#93a0b4",
      }}
    >
      <span style={{ flex: "0 0 auto" }}>{label}</span>
      <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 6 }}>{children}</div>
    </div>
  );
}

export function MenuDivider() {
  return <div style={{ height: 1, background: "#262c36", margin: "4px 6px" }} />;
}
