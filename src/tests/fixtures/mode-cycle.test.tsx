// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { SourceEditor } from "../../features/editor/SourceEditor";
import { Reader } from "../../features/reader/Reader";
import { VisualSurface, type VisualDocumentPort } from "../../features/visual/VisualSurface";
import { DocumentStore } from "../../features/documents/DocumentStore";
import { native } from "../../services/native";

const directory = join(__dirname, "../../../fixtures/markdown");
function files(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const next = join(path, entry.name);
    return entry.isDirectory() ? files(next) : entry.name.endsWith(".md") ? [next] : [];
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => new DOMRect() });
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
});
afterEach(() => {
  Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  Reflect.deleteProperty(Range.prototype, "getClientRects");
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

// Real view adapters, including CodeMirror normalization and Visual mount/
// cleanup. This is a component gate; packaged IPC and disk writes are separate.
it.each(files(directory).map((path) => [relative(directory, path), path]))("no-edit four-mode cycles preserve the corpus: %s", async (_name, path) => {
  const bytes = readFileSync(path!);
  const bom = bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191]));
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(bom ? 3 : 0));
  const snapshot = Object.freeze({ docId: path!, revision: 17, text });
  const store = new DocumentStore();
  const separator = /\r\n|\r|\n/.exec(text)?.[0];
  vi.spyOn(native.documents, "snapshot").mockResolvedValue({
    docId: path!, path: path!, content: text, bom,
    newline: separator === "\r\n" ? "crlf" : separator === "\r" ? "cr" : separator === "\n" ? "lf" : "none", revision: 17,
    savedContentHash: "fixture-hash", savedDiskRevision: null, diskRevision: null,
    dirty: false, draftActive: null,
  });
  vi.spyOn(native.documents, "acquire").mockResolvedValue(1);
  await store.attachDocument(path!);
  const before = structuredClone(store.get(path!));
  const edit = vi.spyOn(store, "editGroup");
  const apply = vi.spyOn(native.documents, "apply").mockImplementation(async () => { throw new Error("unexpected canonical transaction"); });
  const port: VisualDocumentPort = {
    captureSourceSnapshot: vi.fn(async () => snapshot),
    applyLocalizedEdit: vi.fn(async () => { throw new Error("unexpected mutation"); }),
    draftPort: {
      info: vi.fn(async () => null), snapshot: vi.fn(async () => snapshot),
      acquire: vi.fn(async () => { throw new Error("unexpected draft"); }),
      update: vi.fn(async () => { throw new Error("unexpected draft"); }),
      release: vi.fn(async () => { throw new Error("unexpected draft"); }),
      apply: vi.fn(async () => { throw new Error("unexpected draft"); }),
      watch: vi.fn(() => () => {}),
    },
  };
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const noLink = () => {};
  try {
    for (const mode of ["read", "source", "split", "visual", "source", "visual", "split", "source", "read"]) {
      await act(async () => root.render(<>
        <div hidden={mode === "read" || mode === "visual"}><SourceEditor docId={path!} content={text} store={store} /></div>
        <div hidden={mode === "source" || mode === "visual"}><Reader content={text} docPath={path!} onOpenLocal={noLink} onOpenExternal={noLink} /></div>
        {mode === "visual" && <VisualSurface snapshot={snapshot} store={port} renderer={async () => '<svg xmlns="http://www.w3.org/2000/svg"><text>preview</text></svg>'} />}
      </>));
      await store.flushAll();
    }
    expect(edit).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(port.applyLocalizedEdit).not.toHaveBeenCalled();
    expect(port.draftPort.acquire).not.toHaveBeenCalled();
    expect(port.draftPort.apply).not.toHaveBeenCalled();
    expect(snapshot).toEqual({ docId: path, revision: 17, text });
    expect(store.get(path!)).toEqual(before);
    expect(Buffer.concat([bom ? Buffer.from([239, 187, 191]) : Buffer.alloc(0), Buffer.from(snapshot.text)])).toEqual(bytes);
  } finally { await act(async () => root.unmount()); host.remove(); }
}, 30_000);
