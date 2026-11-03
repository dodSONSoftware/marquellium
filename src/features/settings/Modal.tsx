import { useEffect, useRef, type ReactNode } from "react";
/** Native dialog semantics provide focus containment; Escape and close restore focus. */
export function Modal({ title, onClose, children, suspended = false }: { title: string; onClose?: () => void; children: ReactNode; suspended?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const previous = document.activeElement; const dialog = ref.current!; return () => { dialog.close(); if (previous instanceof HTMLElement) previous.focus(); }; }, []);
  useEffect(() => { const dialog = ref.current!; if (suspended) dialog.close(); else if (!dialog.open) dialog.showModal(); }, [suspended]);
  return <dialog ref={ref} aria-label={title} className="settings-dialog" onCancel={(e) => { e.preventDefault(); onClose?.(); }}><h2>{title}</h2>{children}<button disabled={!onClose} onClick={onClose}>Close</button></dialog>;
}
