import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";

const PLACEMENT_KEY = "marquellium.preferences-dialog.v1";
interface Bounds { x: number; y: number; width: number; height: number }

export function fitPreferencesBounds(bounds: Bounds, width: number, height: number): Bounds {
  const margin = 8;
  const availableWidth = Math.max(1, width - margin * 2);
  const availableHeight = Math.max(1, height - margin * 2);
  const w = Math.min(availableWidth, Math.max(560, bounds.width));
  const h = Math.min(availableHeight, Math.max(380, bounds.height));
  return {
    x: Math.max(margin, Math.min(bounds.x, width - w - margin)),
    y: Math.max(margin, Math.min(bounds.y, height - h - margin)),
    width: w, height: h,
  };
}

function loadBounds(): Bounds {
  const width = Math.min(960, window.innerWidth - 48);
  const height = Math.min(700, window.innerHeight - 48);
  let bounds = { x: (window.innerWidth - width) / 2, y: (window.innerHeight - height) / 2, width, height };
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(PLACEMENT_KEY) ?? "null");
    if (saved && typeof saved === "object" && ["x", "y", "width", "height"].every((key) =>
      typeof Reflect.get(saved, key) === "number" && Number.isFinite(Reflect.get(saved, key)))) {
      bounds = saved as Bounds;
    }
  } catch { /* Unavailable or malformed placement falls back to a centered dialog. */ }
  return fitPreferencesBounds(bounds, window.innerWidth, window.innerHeight);
}

/** The native dialog owns modality and focus; only its viewport bounds are custom. */
export function PreferencesDialog({ children, onClose, suspended, onPlacementError }: {
  children: ReactNode; onClose?: () => void; suspended?: boolean; onPlacementError: (message: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [bounds, setBounds] = useState(loadBounds);
  const current = useRef(bounds);
  current.current = bounds;
  const report = useRef(onPlacementError);
  report.current = onPlacementError;
  const gesture = useRef<{ pointer: number; kind: "move" | "resize"; x: number; y: number; bounds: Bounds } | null>(null);

  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current!;
    return () => {
      element.close();
      try { localStorage.setItem(PLACEMENT_KEY, JSON.stringify(current.current)); }
      catch { report.current("The preferences dialog position and size could not be saved."); }
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    const element = dialog.current!;
    if (suspended) { gesture.current = null; element.close(); }
    else if (!element.open) { element.showModal(); element.focus({ preventScroll: true }); }
  }, [suspended]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try { localStorage.setItem(PLACEMENT_KEY, JSON.stringify(bounds)); }
      catch { report.current("The preferences dialog position and size could not be saved."); }
    }, 150);
    return () => window.clearTimeout(timer);
  }, [bounds]);
  useEffect(() => {
    const fit = () => { gesture.current = null; setBounds((b) => fitPreferencesBounds(b, window.innerWidth, window.innerHeight)); };
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  const start = (event: PointerEvent<HTMLElement>, kind: "move" | "resize") => {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest("button") && kind === "move")) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { pointer: event.pointerId, kind, x: event.clientX, y: event.clientY, bounds };
  };
  const move = (event: PointerEvent) => {
    const drag = gesture.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    const next = drag.kind === "move"
      ? { ...drag.bounds, x: drag.bounds.x + dx, y: drag.bounds.y + dy }
      : { ...drag.bounds, width: drag.bounds.width + dx, height: drag.bounds.height + dy };
    if (drag.kind === "resize") {
      next.width = Math.min(next.width, window.innerWidth - next.x - 8);
      next.height = Math.min(next.height, window.innerHeight - next.y - 8);
    }
    setBounds(fitPreferencesBounds(next, window.innerWidth, window.innerHeight));
  };
  const stop = () => { gesture.current = null; };
  return <dialog ref={dialog} tabIndex={-1} aria-labelledby="preferences-title" className="settings-dialog preferences-dialog"
    style={{ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height }}
    onCancel={(event) => { event.preventDefault(); onClose?.(); }}>
    <header className="preferences-titlebar" tabIndex={0} aria-label="Move preferences" onPointerDown={(e) => start(e, "move")} onPointerMove={move}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
        event.preventDefault();
        const step = event.shiftKey ? 40 : 10;
        setBounds((b) => fitPreferencesBounds({ ...b,
          x: b.x + (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0),
          y: b.y + (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0),
        }, window.innerWidth, window.innerHeight));
      }}
      onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop}>
      <h2 id="preferences-title">Preferences</h2>
      <button type="button" disabled={!onClose} aria-label="Close preferences" onClick={onClose}>×</button>
    </header>
    {children}
    <button className="preferences-resize" type="button" aria-label="Resize preferences"
      onPointerDown={(e) => start(e, "resize")} onPointerMove={move} onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop}
      onKeyDown={(event) => {
        const amount = event.shiftKey ? 40 : 10;
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
        event.preventDefault();
        setBounds((b) => fitPreferencesBounds({ ...b,
          width: b.width + (event.key === "ArrowRight" ? amount : event.key === "ArrowLeft" ? -amount : 0),
          height: b.height + (event.key === "ArrowDown" ? amount : event.key === "ArrowUp" ? -amount : 0),
        }, window.innerWidth, window.innerHeight));
      }} />
  </dialog>;
}
