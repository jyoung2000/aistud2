// One-shot spotlight — reuses the tour's rect-tracking cutout for the Feature Finder and
// checklist rows ("show me where X is"). Renders a dimmed screen with a pulsing ring
// around the target + a one-line blurb; dismissed by click, Esc, or after a few seconds.
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";

interface SpotReq {
  target: string;
  title: string;
  blurb: string;
  shortcut?: string;
}

let current: SpotReq | null = null;
const listeners = new Set<() => void>();
const get = () => current;
function set(v: SpotReq | null) {
  current = v;
  for (const l of listeners) l();
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Spotlight a data-tour target once (used by the Feature Finder + checklist). */
export function spotlight(target: string, title: string, blurb: string, shortcut?: string): void {
  set({ target, title, blurb, shortcut });
}

export function SpotlightHost() {
  const req = useSyncExternalStore(subscribe, get, get);
  const [rect, setRect] = useState<DOMRect | null>(null);

  useLayoutEffect(() => {
    if (!req) {
      setRect(null);
      return;
    }
    const measure = () => {
      const el = document.querySelector(`[data-tour="${req.target}"]`) as HTMLElement | null;
      setRect(el ? el.getBoundingClientRect() : null);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [req]);

  useEffect(() => {
    if (!req) return;
    const t = window.setTimeout(() => set(null), 6000);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && set(null);
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [req]);

  if (!req) return null;
  if (!rect) {
    // target not on screen (e.g. tool options for another tool) — explain instead of failing
    return (
      <div style={{ position: "fixed", inset: 0, zIndex: 3000 }} onClick={() => set(null)}>
        <div style={{ position: "absolute", inset: 0, background: "rgba(4,8,14,0.6)" }} />
        <div style={{ position: "absolute", left: "50%", top: "20%", transform: "translateX(-50%)", ...card }}>
          <b style={{ color: "#e2e8f0" }}>{req.title}</b>
          <div style={{ color: "#9aa4b2", marginTop: 6 }}>{req.blurb}</div>
          <div style={{ color: "#6b7280", marginTop: 6, fontSize: 11 }}>
            (Its control isn't visible right now — it appears with the relevant tool/state.)
          </div>
        </div>
      </div>
    );
  }
  const below = window.innerHeight - rect.bottom > 130;
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 3000 }} onClick={() => set(null)}>
      <style>{`@keyframes neu-spot {0%,100%{outline-offset:0}50%{outline-offset:5px}}`}</style>
      <div
        style={{
          position: "absolute",
          top: rect.top - 6,
          left: rect.left - 6,
          width: rect.width + 12,
          height: rect.height + 12,
          borderRadius: 10,
          boxShadow: "0 0 0 9999px rgba(4,8,14,0.7)",
          border: "2px solid #22d3ee",
          outline: "2px solid #22d3ee55",
          animation: "neu-spot 1.6s ease-in-out infinite",
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: Math.max(10, Math.min(rect.left, window.innerWidth - 330)),
          top: below ? rect.bottom + 14 : undefined,
          bottom: below ? undefined : window.innerHeight - rect.top + 14,
          ...card,
        }}
      >
        <b style={{ color: "#e2e8f0" }}>{req.title}</b>
        {req.shortcut && (
          <span style={{ marginLeft: 8, padding: "0 6px", border: "1px solid #3a414d", borderRadius: 4, color: "#8fa0b5", fontSize: 10.5 }}>
            {req.shortcut}
          </span>
        )}
        <div style={{ color: "#9aa4b2", marginTop: 6 }}>{req.blurb}</div>
      </div>
    </div>
  );
}

const card: React.CSSProperties = {
  width: 320,
  background: "#12151a",
  border: "1px solid #2f3540",
  borderRadius: 10,
  padding: 14,
  font: "12.5px ui-sans-serif, system-ui, sans-serif",
  boxShadow: "0 16px 50px #000b",
};
