// @vitest-environment jsdom
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VisualSurface, type VisualDocumentPort } from "./VisualSurface";
import { prepareLocalizedEdit } from "../../core/localized-edit";
import { applyOps, bytesToString, stringToBytes } from "../../core/ops";
import type { DraftLease, DraftObservation, DraftPort } from "../../core/draft-session";

function harness(text: string, beforeOpen?: (docId: string) => Promise<boolean>, context?: { text: string; anchor: number; head: number }) {
  let snapshot = { docId: "doc", revision: 0, text };
  let lease: DraftLease | null = null;
  let token = 0;
  const history: string[] = [];
  const renderers = new Set<() => void>();
  const observers = new Set<(event: DraftObservation) => void>();
  const notify = () => { for (const fn of renderers) fn(); for (const fn of observers) fn({ snapshot }); };
  const commit = (next: string) => { history.push(snapshot.text); snapshot = { ...snapshot, revision: snapshot.revision + 1, text: next }; notify(); };
  const port: DraftPort = {
    snapshot: async () => ({ ...snapshot }), info: async () => structuredClone(lease),
    acquire: async (docId, opening) => {
      if (lease || opening.baseRevision !== snapshot.revision) throw new Error("owned or stale");
      lease = { docId, token: `lease-${++token}`, opening, ownerWindow: "prototype", text: opening.openingText, generation: 0, valid: false };
      return structuredClone(lease);
    },
    update: async (_id, currentToken, update) => {
      if (!lease || lease.token !== currentToken || update.generation < lease.generation) throw new Error("stale lease");
      lease = { ...lease, ...update }; return structuredClone(lease);
    },
    release: async () => { lease = null; for (const fn of observers) fn({ lease: null }); },
    apply: async (current, ops) => {
      if (!lease || lease.token !== current.token || !lease.valid || lease.generation !== current.generation || current.opening.baseRevision !== snapshot.revision) throw new Error("invalid lease");
      if (ops.length) {
        const result = applyOps(stringToBytes(snapshot.text), ops);
        if (!result.ok) throw new Error("invalid ops");
        commit(bytesToString(result.next));
      }
      lease = null;
      for (const fn of observers) fn({ lease: null });
    },
    watch: (_id, callback) => { observers.add(callback); return () => { observers.delete(callback); }; },
  };
  const store: VisualDocumentPort = {
    captureSourceSnapshot: async () => ({ ...snapshot }), draftPort: port,
    applyLocalizedEdit: vi.fn(async (edit) => {
      if (lease) throw new Error("draft active");
      const result = applyOps(stringToBytes(snapshot.text), prepareLocalizedEdit(snapshot, edit));
      if (!result.ok) throw new Error("bad ops");
      commit(bytesToString(result.next));
    }),
  };
  function Component() {
    const [, update] = useState(0);
    useEffect(() => { const listener = () => update((n) => n + 1); renderers.add(listener); return () => { renderers.delete(listener); }; }, []);
    return <VisualSurface snapshot={{ ...snapshot }} context={context} store={store} beforeOpen={beforeOpen} renderer={async () => "<svg><rect width='10' height='10'/></svg>"} />;
  }
  return { Component, store, history, get snapshot() { return snapshot; }, get lease() { return lease; },
    sourceEdit: (text: string) => { snapshot = { ...snapshot, revision: snapshot.revision + 1, text }; notify(); },
    undo: () => { const text = history.pop(); if (text === undefined) throw new Error("empty history"); snapshot = { ...snapshot, revision: snapshot.revision + 1, text }; notify(); },
  };
}
let root: Root;
let container: HTMLDivElement;
const rangeProperties = ["getClientRects", "getBoundingClientRect"] as const;
const savedDescriptors = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("URL", class extends URL { static createObjectURL = vi.fn(() => "blob:preview"); static revokeObjectURL = vi.fn(); });
  for (const key of rangeProperties) {
    savedDescriptors.set(key, Object.getOwnPropertyDescriptor(Range.prototype, key));
    Object.defineProperty(Range.prototype, key, { configurable: true, value: key === "getClientRects" ? () => [] : () => new DOMRect() });
  }
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  for (const key of rangeProperties) { const saved = savedDescriptors.get(key); if (saved) Object.defineProperty(Range.prototype, key, saved); else Reflect.deleteProperty(Range.prototype, key); }
  vi.unstubAllGlobals();
});
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find((button) => button.textContent === label);
  if (!button) throw new Error(`button not found: ${label}`);
  await act(async () => { button.click(); });
}
async function type(label: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!input) throw new Error(`input not found: ${label}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function editor(): EditorView {
  const content = container.querySelector<HTMLElement>(".cm-content");
  const view = content && EditorView.findFromDOM(content);
  if (!view) throw new Error("CM view missing");
  return view;
}

describe("Visual prototype DOM integration", () => {
  it("canceled ownership resolution does not replace another window's draft", async () => {
    const beforeOpen = vi.fn(async () => false);
    const h = harness("Original.", beforeOpen);
    const opening = { baseRevision: 0, startByte: 0, endByte: 9, openingText: "Original.", kind: "source" as const };
    const lease = await h.store.draftPort.acquire("doc", opening);
    await h.store.draftPort.update("doc", lease.token, { generation: 1, text: "other window draft", valid: true });
    await act(async () => root.render(<h.Component />));
    await click("Edit block source");
    expect(beforeOpen).toHaveBeenCalledWith("doc");
    expect(container.querySelector(".cm-editor")).toBeNull();
    expect(h.lease?.text).toBe("other window draft");
    expect(h.history).toHaveLength(0);
  });

  it.each(["Original heading ", ""])("recovers direct heading input after a temporary rejected value: %j", async (temporary) => {
    const original = "### Original heading\n\n<!-- KEEP -->";
    const h = harness(original);
    await act(async () => root.render(<h.Component />));
    await type("Edit heading text", temporary);
    expect(h.snapshot.text).toBe(original);
    expect(h.history).toHaveLength(0);
    await type("Edit heading text", "Original heading dude");
    expect(h.snapshot.text).toBe("### Original heading dude\n\n<!-- KEEP -->");
    expect(h.history).toHaveLength(1);
    expect(container.querySelector('[aria-label="Retained uncommitted text"]')).toBeNull();
  });

  it("edits rendered text with literal escaping and keeps unrelated source intact", async () => {
    const h = harness("**bold**\r\n\r\n<!-- KEEP -->");
    await act(async () => root.render(<h.Component />));
    await type("Edit paragraph text", "bold *literal*");
    expect(h.snapshot.text).toBe("**bold \\*literal\\***\r\n\r\n<!-- KEEP -->");
    expect(h.history).toHaveLength(1);
    expect(container.querySelector("strong input")).not.toBeNull();
  });

  it("runs direct table → real CM draft → Revert/Undo → Apply → direct table with one Apply history entry", async () => {
    const original = "Before.\r\n\r\n| a | b |\r\n|:---|---:|\r\n| one | two |\r\n\r\n<!-- KEEP -->";
    const h = harness(original);
    await act(async () => root.render(<h.Component />));
    await type("Edit table cell 2,2", "three");
    const beforeApply = h.snapshot.text;
    expect(beforeApply).toBe(original.replace("two", "three"));
    await click("Edit table source");
    const draft = editor().state.doc.toString().replace("three", "four");
    await act(async () => { const view = editor(); view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: draft } }); });
    expect(h.snapshot.text).toBe(beforeApply);
    expect(h.history).toHaveLength(1);
    expect(container.textContent).toContain("four");
    await click("Revert");
    expect(editor().state.doc.toString()).not.toContain("four");
    await act(async () => { undo(editor()); });
    expect(editor().state.doc.toString()).toContain("four");
    await click("Apply");
    expect(h.lease).toBeNull();
    expect(container.querySelector(".cm-editor")).toBeNull();
    expect(h.snapshot.text).toBe(original.replace("two", "four"));
    expect(h.history).toHaveLength(2);
    await act(async () => h.undo());
    expect(h.snapshot.text).toBe(beforeApply);
    await type("Edit table cell 2,2", "five");
    expect(h.snapshot.text).toBe(original.replace("two", "five"));
  });

  it("blocks invalid table Apply, keeps last valid preview, and Cancel leaves canonical/history unchanged", async () => {
    const h = harness("| a | b |\n|---|---|\n|one|two|");
    await act(async () => root.render(<h.Component />));
    await click("Edit table source");
    await act(async () => { const view = editor(); view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "invalid table" } }); });
    expect([...container.querySelectorAll("button")].find((button) => button.textContent === "Apply")?.disabled).toBe(true);
    expect(container.querySelector("table")).not.toBeNull();
    expect(h.history).toHaveLength(0);
    await click("Cancel");
    expect(h.snapshot.text).toBe("| a | b |\n|---|---|\n|one|two|");
    expect(h.lease).toBeNull();
  });

  it("shows stale draft feedback after a remote edit and never overwrites that edit", async () => {
    const h = harness("Original.");
    await act(async () => root.render(<h.Component />));
    await click("Edit block source");
    await act(async () => { const view = editor(); view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "local draft" } }); });
    await act(async () => h.sourceEdit("REMOTE"));
    expect(container.textContent).toContain("Document changed");
    expect([...container.querySelectorAll("button")].find((button) => button.textContent === "Apply")?.disabled).toBe(true);
    expect(editor().state.doc.toString()).toBe("local draft");
    await click("Cancel");
    expect(h.snapshot.text).toBe("REMOTE");
  });

  it("retains the diagram preview on an invalid fence and applies only the restored Mermaid block", async () => {
    const original = "<!-- BEFORE -->\r\n\r\n~~~~mermaid title\r\nflowchart LR\r\nA-->B\r\n~~~~\r\n\r\n<!-- AFTER -->";
    const h = harness(original);
    await act(async () => root.render(<h.Component />));
    await click("Edit Mermaid source");
    const opening = editor().state.doc.toString();
    await act(async () => { const view = editor(); view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: opening.replace(/~~~~$/, "") } }); });
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:preview");
    expect([...container.querySelectorAll("button")].find((button) => button.textContent === "Apply")?.disabled).toBe(true);
    expect(h.snapshot.text).toBe(original);
    expect(h.history).toHaveLength(0);
    await act(async () => { const view = editor(); view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: opening.replace("A-->B", "A-->C") } }); });
    await click("Apply");
    expect(h.snapshot.text).toBe(original.replace("A-->B", "A-->C"));
    expect(h.history).toHaveLength(1);
    expect(h.lease).toBeNull();
  });

  it("renders protected HTML inertly and engine SVG only as an image blob", async () => {
    const h = harness("<script>evil()</script>\n\n```mermaid\nflowchart LR\nA-->B\n```");
    await act(async () => root.render(<h.Component />));
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("Protected source");
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:preview");
    expect(h.history).toHaveLength(0);
  });

  it("bounds prototype document display without changing source", async () => {
    const h = harness("x".repeat(140_000));
    await act(async () => root.render(<h.Component />));
    expect(container.textContent).toContain("Source-only block");
    expect(container.querySelector("pre")?.textContent?.length).toBeLessThanOrEqual(1025);
    expect(h.history).toHaveLength(0);
    expect(h.snapshot.text).toHaveLength(140_000);
  });
});


describe("source-anchored bounded rendering", () => {
  it("opens the page containing a source selection and selects the exact leaf", async () => {
    const text = Array.from({ length: 130 }, (_, i) => `Paragraph ${i}.`).join("\n\n");
    const from = text.indexOf("Paragraph 100");
    const h = harness(text, undefined, { text, anchor: from + 2, head: from + 7 });
    await act(async () => root.render(<h.Component />));
    const focused = document.activeElement as HTMLInputElement;
    expect(focused.value).toBe("Paragraph 100.");
    expect([focused.selectionStart, focused.selectionEnd]).toEqual([2, 7]);
    expect(container.querySelectorAll(".visual-block").length).toBeLessThanOrEqual(60);
    await click("Next blocks");
    expect(container.textContent).toContain("Blocks 121–130");
    expect(h.history).toEqual([]);
    expect(h.snapshot.text).toBe(text);
  });
  it("bounds controls for a one MiB document without truncating canonical source", async () => {
    const text = Array.from({ length: 11000 }, (_, i) => `${i}: ` + "preserved content ".repeat(6)).join("\n\n");
    const h = harness(text);
    await act(async () => root.render(<h.Component />));
    expect(container.querySelectorAll(".visual-block")).toHaveLength(60);
    expect(container.textContent).toContain("Next blocks");
    expect(h.snapshot.text).toBe(text);
    expect(h.history).toEqual([]);
  });
});

describe("M4 Visual DOM editing", () => {
  it("edits nested rendered lists and task state as localized shared history entries", async () => {
    const original = "- [ ] Task\n  - Nested **bold**\n\n<!-- EXACT -->";
    const h = harness(original); await act(async () => root.render(<h.Component />));
    await type("Edit list text", "Changed task");
    expect(h.snapshot.text).toBe(original.replace("Task", "Changed task"));
    await act(async () => container.querySelector<HTMLInputElement>('[aria-label="Toggle task"]')!.click());
    expect(h.snapshot.text).toBe(original.replace("Task", "Changed task").replace("[ ]", "[x]"));
    expect(h.history).toHaveLength(2);
  });
  it("inserts blocks, edits an empty table cell, and applies table helpers", async () => {
    const h = harness("| A | B |\n|:---|---:|\n| x | |\n\n<!-- EXACT -->"); await act(async () => root.render(<h.Component />));
    await type("Edit table cell 2,2", "a|b");
    expect(h.snapshot.text).toContain("a\\|b");
    await click("Add row"); expect(h.snapshot.text).toContain("| | |\n| x |");
    await click("Align center"); expect(h.snapshot.text).toContain("|:---:|---:|");
    await click("Insert heading"); expect(h.snapshot.text).toContain("<!-- EXACT -->\n\n## New heading");
    expect(h.history).toHaveLength(4);
  });
  it("uses isolated math draft validation and one canonical Apply entry", async () => {
    const original = "$$\nx^2\n$$\n\n<!-- EXACT -->";
    const h = harness(original); await act(async () => root.render(<h.Component />));
    expect(container.querySelector(".katex")).not.toBeNull();
    await click("Edit math source");
    await act(async () => { const view = editor(); view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "$$\n\\frac{\n$$" } }); });
    expect(h.snapshot.text).toBe(original);
    expect([...container.querySelectorAll("button")].find((b) => b.textContent === "Apply")?.disabled).toBe(true);
    expect(container.querySelector(".katex")).not.toBeNull();
    await act(async () => { const view = editor(); view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "$$\nx^3\n$$" } }); });
    await click("Apply"); expect(h.snapshot.text).toBe(original.replace("x^2", "x^3")); expect(h.history).toHaveLength(1);
  });
  it("formats a selected rendered leaf through one canonical block transaction", async () => {
    const h = harness("Original paragraph.\n\n<!-- EXACT -->"); await act(async () => root.render(<h.Component />));
    const input = container.querySelector<HTMLInputElement>('[aria-label="Edit paragraph text"]')!;
    await act(async () => { input.focus(); input.setSelectionRange(0, 8); input.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); });
    await act(async () => window.dispatchEvent(new CustomEvent("visual-command", { detail: "bold" })));
    expect(h.snapshot.text).toBe("**Original** paragraph.\n\n<!-- EXACT -->"); expect(h.history).toHaveLength(1);
  });
});

it("keeps an empty cell's live input mounted across typing, clearing and refilling", async () => {
  const original = "| A | B |\n|---|---|\n| x | |\n\n<!-- KEEP -->";
  const h = harness(original); await act(async () => root.render(<h.Component />));
  const input = container.querySelector<HTMLInputElement>('[aria-label="Edit table cell 2,2"]')!;
  input.focus();
  await type("Edit table cell 2,2", "a");
  expect(container.querySelector('[aria-label="Edit table cell 2,2"]')).toBe(input);
  expect(document.activeElement).toBe(input);
  await type("Edit table cell 2,2", "a|b");
  expect(h.snapshot.text).toBe(original.replace("| x | |", "| x | a\\|b|"));
  await type("Edit table cell 2,2", ""); expect(h.snapshot.text).toBe(original);
  await type("Edit table cell 2,2", "refilled");
  expect(h.snapshot.text).toContain("| x | refilled|");
  expect(container.querySelector('[aria-label="Edit table cell 2,2"]')).toBe(input);
});
