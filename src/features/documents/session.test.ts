/**
 * FR-033/FR-004: session persistence/restoration mapping.
 *
 * Pinned properties:
 *  - the session never carries content and never carries untitled docs
 *    (restoring it can therefore never overwrite unsaved content);
 *  - the active index survives untitled-tab omission (re-mapped, not
 *    raw index);
 *  - a restored session whose active file is gone falls back to the
 *    last restored tab rather than a stale index.
 */
import { describe, expect, it } from "vitest";
import { pickRestoredActive, sessionFromTabs, type TabRef } from "./session";

const tabs: TabRef[] = [
  { docId: "doc-a", mode: "read" },
  { docId: "untitled-1", mode: "source" },
  { docId: "doc-b", mode: "split" },
];

const pathOf = (docId: string): string | null =>
  docId === "doc-a"
    ? "/notes/a.md"
    : docId === "doc-b"
      ? "/notes/b.md"
      : null;

describe("sessionFromTabs", () => {
  it("persists file-backed tabs with their per-tab mode", () => {
    const s = sessionFromTabs(tabs, pathOf, "doc-b", ["/notes/b.md"]);
    expect(s.tabs).toEqual([
      { path: "/notes/a.md", mode: "read" },
      { path: "/notes/b.md", mode: "split" },
    ]);
    expect(s.recentFiles).toEqual(["/notes/b.md"]);
  });

  it("omits untitled tabs (recovery owns their content, FR-006)", () => {
    const s = sessionFromTabs(tabs, pathOf, "untitled-1", []);
    expect(s.tabs.map((t) => t.path)).toEqual(["/notes/a.md", "/notes/b.md"]);
  });

  it("re-maps the active index across an omitted untitled tab", () => {
    // Active is doc-b, original tab index 2; after omitting the
    // untitled tab it must persist as index 1, not 2.
    const s = sessionFromTabs(tabs, pathOf, "doc-b", []);
    expect(s.activeIndex).toBe(1);
  });

  it("falls back to index 0 when the active tab is untitled", () => {
    const s = sessionFromTabs(tabs, pathOf, "untitled-1", []);
    expect(s.activeIndex).toBe(0);
  });

  it("yields an empty tab list (index 0) when nothing is file-backed", () => {
    const s = sessionFromTabs(
      [{ docId: "u", mode: "source" }],
      () => null,
      "u",
      [],
    );
    expect(s.tabs).toEqual([]);
    expect(s.activeIndex).toBe(0);
  });

  it("carries no document content", () => {
    const s = sessionFromTabs(tabs, pathOf, "doc-a", []);
    for (const t of s.tabs) {
      expect(Object.keys(t).sort()).toEqual(["mode", "path"]);
    }
  });
});

describe("pickRestoredActive", () => {
  it("keeps the saved active tab when it restored", () => {
    // origIndices: restored tabs came from session indices 0 and 2.
    expect(pickRestoredActive(2, [0, 2])).toBe(1);
    expect(pickRestoredActive(0, [0, 2])).toBe(0);
  });

  it("falls back to the last restored tab when the active file was skipped", () => {
    expect(pickRestoredActive(1, [0, 2])).toBe(1);
  });

  it("falls back to the only restored tab for a stale single-tab index", () => {
    expect(pickRestoredActive(7, [0])).toBe(0);
  });
});
