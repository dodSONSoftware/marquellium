import { useEffect, useRef, type ReactNode } from "react";
/** Native dialog semantics provide focus containment; Escape and close restore focus. */
export function Modal({ title, onClose, children, suspended = false, className = "", closeLabel = "Close", footer, showTitle = true }: { title: string; onClose?: () => void; children: ReactNode; suspended?: boolean; className?: string; closeLabel?: string; footer?: ReactNode; showTitle?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const previous = document.activeElement; const dialog = ref.current!; return () => { dialog.close(); if (previous instanceof HTMLElement) previous.focus(); }; }, []);
  useEffect(() => { const dialog = ref.current!; if (suspended) dialog.close(); else if (!dialog.open) dialog.showModal(); }, [suspended]);
  return <dialog ref={ref} aria-label={title} className={`settings-dialog ${className}`} onCancel={(e) => { e.preventDefault(); onClose?.(); }}>{showTitle && <h2>{title}</h2>}{children}<div className="modal-actions">{footer}<button disabled={!onClose} onClick={onClose}>{closeLabel}</button></div></dialog>;
}
