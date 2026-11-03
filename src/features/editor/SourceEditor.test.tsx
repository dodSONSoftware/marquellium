// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { SourceEditor, restoreSourceContext, sourceContext } from "./SourceEditor";
import { DocumentStore } from "../documents/DocumentStore";
import { applyOps, stringToBytes, bytesToString } from "../../core/ops";

const rangeProperties = ["getClientRects", "getBoundingClientRect"] as const;
const rangeDescriptors = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const key of rangeProperties) {
    rangeDescriptors.set(key, Object.getOwnPropertyDescriptor(Range.prototype, key));
    Object.defineProperty(Range.prototype, key, {
      configurable: true, value: key === "getClientRects" ? () => [] : () => new DOMRect(),
    });
  }
});
afterEach(() => {
  for (const key of rangeProperties) {
    const descriptor = rangeDescriptors.get(key);
    if (descriptor) Object.defineProperty(Range.prototype, key, descriptor);
    else Reflect.deleteProperty(Range.prototype, key);
  }
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
it.each(["\r\n", "\r", "\n", "mixed"])("real CodeMirror changes preserve %s canonical separators", async (ending) => {
  let text = ending === "mixed" ? "😀\r\nOriginal **bold**\rtail\n" : `😀${ending}Original **bold**${ending}tail${ending}`;
  const original = text;
  const store = new DocumentStore();
  const commits = vi.spyOn(store, "editGroup").mockImplementation((_id, ops) => {
    const applied = applyOps(stringToBytes(text), ops);
    if (!applied.ok) throw new Error("invalid ops");
    text = bytesToString(applied.next);
  });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  let editor: EditorView | null = null;
  try {
    await act(async () => root.render(<SourceEditor docId="doc" content={text} store={store} onView={(view) => { editor = view; }} />));
    const view = editor as unknown as EditorView;
    const from = view.state.doc.toString().indexOf("bold");
    await act(async () => view.dispatch({ changes: { from, to: from + 4, insert: "changed" } }));
    expect(text).toBe(original.replace("bold", "changed"));
    expect(commits).toHaveBeenCalledTimes(1);
    const context = { text, anchor: text.indexOf("changed"), head: text.indexOf("changed") + 7 };
    await act(async () => restoreSourceContext(view, context));
    expect(sourceContext(view)).toEqual(context);
    const external = text.replace("tail", "external");
    await act(async () => root.render(<SourceEditor docId="doc" content={external} store={store} />));
    expect(view.state.doc.toString()).toBe(external.replace(/\r\n|\r/g, "\n"));
    expect(commits).toHaveBeenCalledTimes(1);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
it.each([
  ["original single-line corpus", readFileSync("fixtures/markdown/large-1mb.md", "utf8")],
  ["multiline Markdown", Array.from({ length: 10000 }, (_, i) => `## Heading ${i}\n\nParagraph **bold** words with Unicode 東京 and ` + "plain words ".repeat(5)).join("\n\n")],
])("measures the one MiB Source input adapter: %s", async (name, text) => {
  const store = new DocumentStore();
  const edit = vi.spyOn(store, "editGroup").mockImplementation(() => {});
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  let editor: EditorView | null = null;
  try {
    await act(async () => root.render(<SourceEditor docId="large" content={text} store={store} onView={(view) => { editor = view; }} />));
    const view = editor as unknown as EditorView;
    const samples: number[] = [];
    await act(async () => {
      for (let i = 0; i < 30; i++) {
        const started = performance.now();
        view.dispatch({ changes: { from: Math.floor(view.state.doc.length / 2), insert: "x" } });
        samples.push(performance.now() - started);
      }
    });
    samples.sort((a, b) => a - b);
    console.info(`Source adapter 1 MiB (${name}): median=${samples[15]!.toFixed(2)}ms p95=${samples[28]!.toFixed(2)}ms (30 synchronous CM dispatches; excludes native IPC/paint)`);
    expect(edit).toHaveBeenCalledTimes(30);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
it("toggles native spelling without changing editor content or committing document edits", async () => {
  const store = new DocumentStore(), commit = vi.spyOn(store, "editGroup");
  const host = document.createElement("div"), root = createRoot(host);
  const text = "# Speling 😀\r\nKeep exactly.\r\n";
  try {
    await act(async () => root.render(<SourceEditor docId="spelling" content={text} store={store} spellcheck={false} />));
    const content = host.querySelector(".cm-content")!;
    expect(content.getAttribute("spellcheck")).toBe("false");
    await act(async () => root.render(<SourceEditor docId="spelling" content={text} store={store} spellcheck />));
    expect(host.querySelector(".cm-content")).toBe(content);
    expect(content.getAttribute("spellcheck")).toBe("true");
    expect(commit).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
});
