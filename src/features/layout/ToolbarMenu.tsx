import { useEffect, useRef, type ReactNode } from "react";

/** Keep secondary commands compact without hiding them from keyboard navigation. */
export function ToolbarMenu({ label, children, align = "end" }: { label: string; children: ReactNode; align?: "start" | "end" }) {
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target) && menu.current) menu.current.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !menu.current?.open) return;
      event.preventDefault(); event.stopPropagation(); menu.current.open = false;
      menu.current.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape, true); };
  }, []);
  return <details className={`toolbar-menu align-${align}`} name="command-deck-menu" ref={menu}>
    <summary aria-label={label} title={label}>···</summary>
    <div className="toolbar-menu-panel" role="group" aria-label={label} onClick={(event) => {
      const button = event.target instanceof Element ? event.target.closest("button") : null;
      if (button && !button.disabled && menu.current) {
        // Preserve an explicit editor focus handoff; otherwise leave a visible opener.
        if (menu.current.contains(document.activeElement)) menu.current.querySelector("summary")?.focus();
        menu.current.open = false;
      }
    }}>{children}</div>
  </details>;
}
