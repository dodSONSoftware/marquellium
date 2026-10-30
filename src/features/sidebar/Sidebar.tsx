/**
 * Left sidebar (FR-047, pulled forward from M3): a single collapsible,
 * user-resizable panel hosting the document outline (the Files section
 * lands with workspace mode in M4). Collapse state and width persist via
 * the settings store (Rust `sidebar` field; localStorage in browser dev).
 *
 * Outline ids are the same slugs the reader's DOM ids are built from, so
 * click-to-scroll cannot point at a missing element (FR-014).
 */
import { useState, type PointerEvent as ReactPointerEvent } from "react";
import type { OutlineItem } from "../../core/render/outline";
import "./sidebar.css";

export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 560;

export interface SidebarProps {
  outline: OutlineItem[];
  /** True when the active tab renders the reader (headings scrollable). */
  tocActive: boolean;
  /** Slug of the heading currently at the top of the reader (FR-014). */
  activeSlug?: string | null;
  width: number;
  onToggle: (visible: boolean) => void;
  /** Called once, with the final width, when a drag ends. */
  onResize: (width: number) => void;
}

const clampWidth = (w: number) =>
  Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(w)));

export function Sidebar({ outline, tocActive, activeSlug, width, onToggle, onResize }: SidebarProps) {
  // Live width while dragging; committed to the parent (and persisted) on
  // pointer-up, so the settings store isn't spammed per pointermove.
  const [dragWidth, setDragWidth] = useState<number | null>(null);

  const startDrag = (e: ReactPointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const move = (ev: PointerEvent) =>
      setDragWidth(clampWidth(startW + ev.clientX - startX));
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDragWidth(null);
      onResize(clampWidth(startW + ev.clientX - startX));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const jumpTo = (slug: string) => {
    if (!tocActive) return;
    document.getElementById(slug)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <aside className="sidebar" style={{ width: dragWidth ?? width }}>
      <div className="sidebar-header">
        <span>On this page</span>
        <button
          className="sidebar-collapse"
          aria-label="Hide sidebar"
          title="Hide sidebar"
          onClick={() => onToggle(false)}
        >
          ◀
        </button>
      </div>
      <div className="sidebar-body">
        {outline.length === 0 ? (
          <p className="sidebar-empty">No headings in this document.</p>
        ) : tocActive ? (
          <nav aria-label="Table of contents">
            {outline.map((o) => (
              <button
                key={`${o.slug}-${o.line}`}
                className={"sidebar-item" + (o.slug === activeSlug ? " active" : "")}
                style={{ paddingLeft: 10 + (o.depth - 1) * 14 }}
                title={o.text}
                onClick={() => jumpTo(o.slug)}
              >
                {o.text}
              </button>
            ))}
          </nav>
        ) : (
          <p className="sidebar-empty">
            {outline.length} heading{outline.length === 1 ? "" : "s"} — switch to
            Read mode to browse them.
          </p>
        )}
      </div>
      <div
        className="sidebar-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        onPointerDown={startDrag}
      />
    </aside>
  );
}
