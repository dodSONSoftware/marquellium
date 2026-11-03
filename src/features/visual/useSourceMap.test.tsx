// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createSourceMap, type SourceSnapshot } from "../../core/source-map";
import { useSourceMap } from "./useSourceMap";

afterEach(() => { vi.unstubAllGlobals(); });
it("terminates obsolete parsers and ignores their delayed results", async () => {
  const workers: Parser[] = [];
  class Parser {
    onmessage: ((event: { data: { map: ReturnType<typeof createSourceMap> } }) => void) | null = null;
    onerror: (() => void) | null = null;
    terminated = false;
    constructor() { workers.push(this); }
    postMessage() {}
    terminate() { this.terminated = true; }
  }
  vi.stubGlobal("Worker", Parser);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const element = document.createElement("div"); document.body.append(element);
  const root = createRoot(element);
  const first = { docId: "doc", revision: 1, text: "Paragraph.\n\n".repeat(7000) };
  const second = { ...first, revision: 2, text: first.text + "new" };
  function Harness({ snapshot }: { snapshot: SourceSnapshot }) {
    const { map, mapping } = useSourceMap(snapshot);
    return <p>{mapping ? "pending" : map?.snapshot.revision ?? "unavailable"}</p>;
  }
  try {
    await act(async () => root.render(<Harness snapshot={first} />));
    await act(async () => root.render(<Harness snapshot={second} />));
    expect(workers[0]?.terminated).toBe(true);
    await act(async () => workers[0]?.onmessage?.({ data: { map: createSourceMap(first) } }));
    expect(element.textContent).toBe("pending");
    await act(async () => workers[1]?.onmessage?.({ data: { map: createSourceMap(second) } }));
    expect(element.textContent).toBe("2");
  } finally { await act(async () => root.unmount()); element.remove(); }
});
