import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { closeTargets, type CloseAction } from "./tab-order";

interface Tab { docId: string; name: string; dirty: boolean; path: string | null; pinned?: boolean }
interface Props {
  tabs: readonly Tab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (ids: string[]) => void;
  onNew: () => void;
  onMove: (id: string, target: string) => void;
  onPin: (id: string) => void;
  onReveal: (id: string) => void;
}

interface MenuPosition { id: string; x: number; y: number }
interface Gesture { pointer: number; id: string; startX: number; moved: boolean }
const closeActions: [CloseAction, string][] = [
  ["close", "Close"], ["others", "Close Others"], ["right", "Close to the Right"], ["all", "Close All"],
];

function TabMenu({ tab, tabs, position, onClose, onPin, onReveal, dismiss }: Pick<Props, "tabs" | "onClose" | "onPin" | "onReveal"> & {
  tab: Tab; position: MenuPosition; dismiss: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = ref.current!;
    const { width, height } = menu.getBoundingClientRect();
    const anchor = menu.parentElement!;
    anchor.style.left = Math.max(0, Math.min(position.x, window.innerWidth - width)) + "px";
    anchor.style.top = Math.max(0, Math.min(position.y, window.innerHeight - height)) + "px";
    menu.querySelector("button")?.focus();
  }, [position]);
  useEffect(() => {
    const outside = (e: globalThis.PointerEvent) => {
      if (e.target instanceof Node && !ref.current?.contains(e.target)) dismiss();
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("blur", dismiss);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("resize", dismiss);
    };
  }, [dismiss]);
  const run = (action: () => void) => { dismiss(); action(); };
  const navigate = (e: KeyboardEvent) => {
    if (e.key === "Escape" || e.key === "Tab") {
      if (e.key === "Escape") e.preventDefault();
      dismiss();
      return;
    }
    const items = [...ref.current!.querySelectorAll<HTMLButtonElement>("button:enabled")];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? (index + 1) % items.length : e.key === "ArrowUp" ? (index + items.length - 1) % items.length : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : -1;
    if (next >= 0) { e.preventDefault(); items[next]?.focus(); }
  };
  return <div className="tab-menu-anchor"><div className="tab-context-menu" role="menu" aria-label={`Tab actions for ${tab.name}`} ref={ref} onKeyDown={navigate}>
    <button role="menuitem" onClick={() => run(() => onPin(tab.docId))}>{tab.pinned ? "Unpin" : "Pin"}</button>
    <button role="menuitem" disabled={!tab.path} onClick={() => run(() => onReveal(tab.docId))}>
      {/Mac/i.test(navigator.platform) ? "Reveal in Finder" : "Open Containing Folder"}
    </button>
    <hr role="separator" />
    {closeActions.map(([action, label]) => {
      const ids = closeTargets(tabs, tab.docId, action);
      return <button key={action} role="menuitem" disabled={!ids.length} onClick={() => run(() => onClose(ids))}>{label}</button>;
    })}
  </div></div>;
}

/** Manual activation lets keyboard focus move without resolving a draft early. */
export function DocumentTabs({ tabs, activeId, onSelect, onClose, onNew, onMove, onPin, onReveal }: Props) {
  const list = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuPosition | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const menuTab = tabs.find((tab) => tab.docId === menu?.id);

  const clearDrag = () => { gesture.current = null; setDropTarget(null); };
  const targetAt = (e: PointerEvent, id: string) => {
    const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-tab-id]");
    if (!hit || !list.current?.contains(hit) || hit.dataset.tabId === id) return null;
    const source = tabs.find((tab) => tab.docId === id);
    const target = tabs.find((tab) => tab.docId === hit.dataset.tabId);
    return source && target && !!source.pinned === !!target.pinned ? target.docId : null;
  };
  const start = (e: PointerEvent<HTMLButtonElement>, id: string) => {
    suppressClick.current = false;
    if (e.button !== 0 || e.ctrlKey || gesture.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current = { id, pointer: e.pointerId, startX: e.clientX, moved: false };
  };
  const move = (e: PointerEvent) => {
    const drag = gesture.current;
    if (!drag || drag.pointer !== e.pointerId || (!drag.moved && Math.abs(e.clientX - drag.startX) < 5)) return;
    drag.moved = true;
    suppressClick.current = true;
    const strip = list.current?.parentElement;
    if (strip) {
      const bounds = strip.getBoundingClientRect();
      if (e.clientX < bounds.left + 24) strip.scrollLeft -= 18;
      else if (e.clientX > bounds.right - 24) strip.scrollLeft += 18;
    }
    setDropTarget(targetAt(e, drag.id));
  };
  const finish = (e: PointerEvent) => {
    const drag = gesture.current;
    if (!drag || drag.pointer !== e.pointerId) return;
    const target = drag.moved && targetAt(e, drag.id);
    clearDrag();
    if (target) onMove(drag.id, target);
  };
  const showMenu = (position: MenuPosition, element: HTMLElement) => {
    clearDrag();
    opener.current = element.closest(".tab")?.querySelector<HTMLButtonElement>(".tab-select") ?? null;
    setMenu(position);
  };
  const dismiss = () => {
    setMenu(null);
    opener.current?.focus({ preventScroll: true });
  };
  const sourceIndex = tabs.findIndex((tab) => tab.docId === gesture.current?.id);

  return <><div className="tabbar">
    <div className="document-tabs" role="tablist" aria-label="Documents" ref={list}>
      {tabs.map((tab, index) => <div key={tab.docId} data-tab-id={tab.docId}
        className={["tab", tab.pinned && "pinned", tab.docId === activeId && "active", tab.dirty && "dirty", dropTarget === tab.docId && (sourceIndex < index ? "drop-after" : "drop-before")].filter(Boolean).join(" ")}
        onContextMenu={(e) => { e.preventDefault(); showMenu({ id: tab.docId, x: e.clientX, y: e.clientY }, e.currentTarget); }}>
        <button className="tab-select" role="tab" aria-selected={tab.docId === activeId} aria-controls="document-panel" aria-haspopup="menu"
          tabIndex={tab.docId === activeId || activeId === null && index === 0 ? 0 : -1}
          onPointerDown={(e) => start(e, tab.docId)} onPointerMove={move} onPointerUp={finish} onPointerCancel={clearDrag} onLostPointerCapture={clearDrag}
          onClick={(e) => { if (!suppressClick.current || e.detail === 0) onSelect(tab.docId); suppressClick.current = false; }}
          onKeyDown={(e) => {
            if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
              e.preventDefault();
              const rect = e.currentTarget.getBoundingClientRect();
              showMenu({ id: tab.docId, x: rect.left, y: rect.bottom }, e.currentTarget);
              return;
            }
            if (e.key === "Delete") { e.preventDefault(); onClose([tab.docId]); return; }
            const buttons = list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
            if (!buttons?.length) return;
            const target = e.key === "ArrowRight" ? (index + 1) % buttons.length : e.key === "ArrowLeft" ? (index + buttons.length - 1) % buttons.length : e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : null;
            if (target !== null) { e.preventDefault(); buttons[target]?.focus(); }
          }}>
          {tab.pinned && <span className="tab-pin" role="img" aria-label="Pinned">📌</span>}
          <span className="tab-name">{tab.name}</span>{tab.dirty && <span className="dot" role="img" aria-label="unsaved changes" title="Unsaved changes" />}
        </button>
        <button className="tab-close" aria-label={`Close ${tab.name}`} onClick={() => onClose([tab.docId])}>×</button>
      </div>)}
    </div>
    <button className="tab-new" onClick={onNew} aria-label="New document">+</button>
    </div>
    {menu && menuTab && <TabMenu tab={menuTab} position={menu} tabs={tabs} onPin={onPin} onReveal={onReveal} onClose={onClose} dismiss={dismiss} />}
  </>;
}
