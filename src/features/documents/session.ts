/**
 * Pure helpers for session persistence and restoration (FR-033/FR-004).
 *
 * The session stores file paths + modes only — never content. Untitled
 * documents are not session tabs: their (possibly unsaved) content is
 * owned by the crash-recovery snapshots (FR-006), so restoring a session
 * can structurally never overwrite unsaved content.
 */
import type { SessionState } from "../../services/native";

export interface TabRef {
  docId: string;
  mode: string;
}

/**
 * Derive the persisted session state from the live tab list. Untitled
 * tabs (no path) are omitted; the active index is re-mapped into the
 * filtered list, falling back to the first persisted tab when the
 * active tab itself is untitled or absent.
 */
export function sessionFromTabs(
  tabs: TabRef[],
  pathOf: (docId: string) => string | null,
  activeId: string | null,
  recentFiles: string[],
): SessionState {
  const persisted: SessionState["tabs"] = [];
  let activeIdx = -1;
  tabs.forEach((t) => {
    const path = pathOf(t.docId);
    if (!path) return;
    if (t.docId === activeId) activeIdx = persisted.length;
    persisted.push({ path, mode: t.mode });
  });
  return {
    schemaVersion: 1,
    tabs: persisted,
    activeIndex: activeIdx >= 0 ? activeIdx : 0,
    recentFiles,
  };
}

/**
 * Pick which restored tab becomes active: the one whose ORIGINAL session
 * index matches the saved active index, or the last restored tab when the
 * saved active file was skipped during restore (missing/unreadable).
 */
export function pickRestoredActive(
  wanted: number,
  origIndices: number[],
): number {
  const hit = origIndices.indexOf(wanted);
  return hit >= 0 ? hit : origIndices.length - 1;
}
