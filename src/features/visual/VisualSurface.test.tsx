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

function harness(text: string) {
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
    return <VisualSurface snapshot={{ ...snapshot }} store={store} renderer={async () => "<svg><rect width='10' height='10'/></svg>"} />;
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
    expect(container.textContent).toContain("exceeds the prototype");
    expect(h.history).toHaveLength(0);
    expect(h.snapshot.text).toHaveLength(140_000);
  });
});
