import { useRef, useState } from "react";

interface Tab { docId: string; name: string; dirty: boolean }
interface Props {
  tabs: readonly Tab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onMove: (from: number, to: number) => void;
}

/** Manual activation lets keyboard focus move without resolving a draft early. */
export function DocumentTabs({ tabs, activeId, onSelect, onClose, onNew, onMove }: Props) {
  const list = useRef<HTMLDivElement>(null);
  const [dragged, setDragged] = useState<number | null>(null);
  return <div className="tabbar">
    <div className="document-tabs" role="tablist" aria-label="Documents" ref={list}>
      {tabs.map((tab, index) => <div key={tab.docId} className={`tab${tab.docId === activeId ? " active" : ""}${tab.dirty ? " dirty" : ""}${dragged === index ? " dragging" : ""}`} draggable
        onDragStart={(event) => { setDragged(index); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", tab.docId); }}
        onDragOver={(event) => { event.preventDefault(); if (dragged === null || dragged === index) return; event.dataTransfer.dropEffect = "move"; onMove(dragged, index); setDragged(index); }}
        onDrop={(event) => event.preventDefault()} onDragEnd={() => setDragged(null)}>
        <button className="tab-select" role="tab" aria-selected={tab.docId === activeId} aria-controls="document-panel" tabIndex={tab.docId === activeId || activeId === null && index === 0 ? 0 : -1}
          onClick={() => onSelect(tab.docId)} onKeyDown={(event) => {
            if (event.key === "Delete") { event.preventDefault(); onClose(tab.docId); return; }
            const buttons = list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
            if (!buttons?.length) return;
            const target = event.key === "ArrowRight" ? (index + 1) % buttons.length : event.key === "ArrowLeft" ? (index + buttons.length - 1) % buttons.length : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : null;
            if (target !== null) { event.preventDefault(); buttons[target]?.focus(); }
          }}>
          <span className="tab-name">{tab.name}</span>{tab.dirty && <span className="dot" aria-label="unsaved changes" />}
        </button>
        <button className="tab-close" aria-label={`Close ${tab.name}`} onClick={() => onClose(tab.docId)}>×</button>
      </div>)}
    </div>
    <button className="tab-new" onClick={onNew} aria-label="New document">+</button>
  </div>;
}
