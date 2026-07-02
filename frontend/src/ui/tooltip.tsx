// Styled tooltip (replaces native title=): 150 ms delay, shows
// "Name — description · [Key]". Wrap any element with <Tip>. Also carries the
// disabled-reason pattern: pass `reason` when the child is disabled so hover explains WHY.
import { cloneElement, isValidElement, useEffect, useRef, useState } from "react";

export function Tip({
  name,
  desc,
  keys,
  reason,
  children,
  side = "bottom",
}: {
  name: string;
  desc?: string;
  keys?: string; // shortcut, e.g. "V"
  reason?: string | null; // why-disabled line (overrides desc when set)
  children: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
}) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const timer = useRef<number>(0);
  const anchor = useRef<HTMLSpanElement>(null);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const enter = () => {
    timer.current = window.setTimeout(() => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      const x =
        side === "left" ? r.left - 8 : side === "right" ? r.right + 8 : r.left + r.width / 2;
      const y = side === "top" ? r.top - 8 : side === "bottom" ? r.bottom + 8 : r.top + r.height / 2;
      setPos({ x, y });
      setShow(true);
    }, 150);
  };
  const leave = () => {
    window.clearTimeout(timer.current);
    setShow(false);
  };

  const body = reason ?? desc;

  return (
    <span
      ref={anchor}
      onMouseEnter={enter}
      onMouseLeave={leave}
      onMouseDown={leave}
      style={{ display: "inline-flex" }}
    >
      {isValidElement(children) ? cloneElement(children) : children}
      {show && pos && (
        <span
          style={{
            position: "fixed",
            left: pos.x,
            top: pos.y,
            transform:
              side === "bottom"
                ? "translate(-50%, 0)"
                : side === "top"
                ? "translate(-50%, -100%)"
                : side === "right"
                ? "translate(0, -50%)"
                : "translate(-100%, -50%)",
            zIndex: 5000,
            maxWidth: 280,
            background: "#1b2028f2",
            border: "1px solid #333a45",
            borderRadius: 6,
            padding: "6px 9px",
            font: "11px ui-sans-serif, system-ui, sans-serif",
            color: "#dbe3ee",
            boxShadow: "0 6px 18px #000a",
            pointerEvents: "none",
            whiteSpace: "normal",
          }}
        >
          <b>{name}</b>
          {body && <span style={{ color: "#9aa7b8" }}> — {body}</span>}
          {keys && !reason && (
            <span
              style={{
                marginLeft: 6,
                padding: "0 5px",
                border: "1px solid #3a414d",
                borderRadius: 4,
                color: "#8fa0b5",
                fontSize: 10,
              }}
            >
              {keys}
            </span>
          )}
        </span>
      )}
    </span>
  );
}
