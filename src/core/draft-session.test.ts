import { describe, expect, it, vi } from "vitest";
import { undoDepth, redoDepth } from "@codemirror/commands";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DraftSession, type DraftLease, type DraftObservation, type DraftPort, type DraftValidator } from "./draft-session";
import { createSourceMap } from "./source-map";
import { applyOps, bytesToString, stringToBytes } from "./ops";
import { InlineSourceEditor } from "../features/visual/InlineSourceEditor";

/** Protocol double; Rust ownership/atomicity tests exercise the real registry. */
function harness(text = "Original **source**.") {
  let snapshot = { docId: "doc", revision: 0, text };
  let lease: DraftLease | null = null;
  let next = 0;
  const canonicalHistory: string[] = [];
  const watchers = new Set<(event: DraftObservation) => void>();
  const notify = (event: DraftObservation) => { for (const listener of watchers) listener(event); };
  const port: DraftPort = {
    snapshot: vi.fn(async () => ({ ...snapshot })),
    info: vi.fn(async () => structuredClone(lease)),
    resume: vi.fn(async (_docId, token) => {
      if (!lease || lease.ownerWindow !== null || lease.token !== token) throw new Error("not orphaned");
      lease = { ...lease, ownerWindow: "resumed", token: `token-${++next}`, valid: false };
      return structuredClone(lease);
    }),
    acquire: vi.fn(async (docId, opening) => {
      if (lease) throw new Error("resolve current draft first");
      lease = { docId, opening: structuredClone(opening), token: `token-${++next}`, ownerWindow: "a", generation: 0, text: opening.openingText, valid: false };
      return structuredClone(lease);
    }),
    update: vi.fn(async (_docId, token, update) => {
      if (!lease || lease.token !== token) throw new Error("ownership changed");
      if (update.generation < lease.generation) throw new Error("stale update");
      Object.assign(lease, update);
      notify({ lease: structuredClone(lease) });
      return structuredClone(lease);
    }),
    release: vi.fn(async (_docId, token) => {
      if (!lease || lease.token !== token) throw new Error("ownership changed");
      lease = null;
      notify({ lease: null });
    }),
    apply: vi.fn(async (current, ops) => {
      if (!lease || !lease.valid || lease.token !== current.token || lease.generation !== current.generation || snapshot.revision !== current.opening.baseRevision) throw new Error("invalid or stale lease");
      if (ops.length) {
        const result = applyOps(stringToBytes(snapshot.text), ops);
        if (!result.ok) throw new Error("invalid byte ops");
        canonicalHistory.push(snapshot.text);
        snapshot = { ...snapshot, revision: snapshot.revision + 1, text: bytesToString(result.next) };
        notify({ snapshot: { ...snapshot } });
      }
      lease = null;
      notify({ lease: null });
    }),
    watch: vi.fn((_docId, listener) => { watchers.add(listener); return () => { watchers.delete(listener); }; }),
  };
  const valid: DraftValidator = () => ({ valid: true, diagnostics: [] });
  return {
    port, notify, canonicalHistory,
    orphan: () => { if (!lease) throw new Error("missing lease"); lease = { ...lease, ownerWindow: null, valid: false }; notify({ lease: structuredClone(lease) }); },
    get snapshot() { return { ...snapshot }; },
    get lease() { return structuredClone(lease); },
    sourceEdit: (text: string) => { snapshot = { ...snapshot, revision: snapshot.revision + 1, text }; notify({ snapshot: { ...snapshot } }); },
    replaceOwner: () => { if (!lease) throw new Error("missing lease"); lease = { ...lease, token: `token-${++next}`, ownerWindow: "b" }; notify({ lease: structuredClone(lease) }); },
    open: (validate = valid) => {
      const map = createSourceMap(snapshot);
      return DraftSession.open(map, map.blocks[0]!, "source", port, validate);
    },
  };
}

describe("isolated draft history and ownership", () => {
  it("resumes a recovered modified draft with fresh local history and one canonical Apply", async () => {
    const h = harness();
    const original = await h.open();
    original.replaceText("recovered draft"); await original.settle();
    h.orphan();
    const map = createSourceMap(h.snapshot);
    const restored = await DraftSession.resume(map, map.blocks[0]!, h.port, () => ({ valid: true, diagnostics: [] }));
    await restored.settle();
    expect(restored.text).toBe("recovered draft");
    expect(restored.modified).toBe(true);
    expect(undoDepth(restored.state)).toBe(0);
    expect(h.snapshot.text).toBe("Original **source**.");
    await restored.apply();
    expect(h.snapshot.text).toBe("recovered draft");
    expect(h.canonicalHistory).toHaveLength(1);
  });

  it("refuses to attach an orphan to a shifted base without mutating or losing its text", async () => {
    const h = harness();
    const original = await h.open();
    original.replaceText("preserve draft"); await original.settle();
    h.orphan();
    h.sourceEdit("Prefix.\n\nOriginal **source**.");
    const map = createSourceMap(h.snapshot);
    await expect(DraftSession.resume(map, map.blocks[1]!, h.port, () => ({ valid: true, diagnostics: [] }))).rejects.toThrow("does not match");
    expect(h.lease?.text).toBe("preserve draft");
    expect(h.lease?.ownerWindow).toBeNull();
    expect(h.canonicalHistory).toHaveLength(0);
  });

  it("Revert is an independent local undo step; Cancel destroys history without canonical mutation", async () => {
    const h = harness();
    const session = await h.open();
    await session.settle();
    session.replaceText("draft before Revert");
    session.revert();
    expect(session.text).toBe("Original **source**.");
    expect(session.closed).toBe(false);
    expect(session.undo()).toBe(true);
    expect(session.text).toBe("draft before Revert");
    expect(redoDepth(session.state)).toBe(1);
    await session.settle();
    expect(h.snapshot.text).toBe("Original **source**.");
    expect(h.canonicalHistory).toHaveLength(0);
    await session.cancel();
    expect(session.closed).toBe(true);
    expect(() => session.state).toThrow("destroyed");
    expect(h.lease).toBeNull();
    const reopened = await h.open();
    expect(undoDepth(reopened.state)).toBe(0);
    expect(redoDepth(reopened.state)).toBe(0);
    await reopened.cancel();
  });

  it("retains draft history beyond CodeMirror's default trimming depth", async () => {
    const h = harness("Initial");
    const session = await h.open();
    for (let i = 0; i < 150; i++) session.replaceText(`Edit ${i}`);
    expect(undoDepth(session.state)).toBe(150);
    for (let i = 0; i < 150; i++) expect(session.undo()).toBe(true);
    expect(session.text).toBe("Initial");
    await session.cancel();
    expect(h.canonicalHistory).toHaveLength(0);
  });

  it("Apply uses one canonical transaction and destroys the temporary history", async () => {
    const h = harness();
    const session = await h.open();
    session.replaceText("Changed **source**.");
    await session.settle();
    expect(session.canApply).toBe(true);
    await session.apply();
    expect(h.snapshot.text).toBe("Changed **source**.");
    expect(h.canonicalHistory).toEqual(["Original **source**."]);
    expect(h.port.apply).toHaveBeenCalledOnce();
    expect(h.lease).toBeNull();
    expect(session.closed).toBe(true);
    expect(() => session.undo()).toThrow("destroyed");
  });

  it("unchanged Apply still releases the lease but submits no canonical operations", async () => {
    const h = harness();
    const session = await h.open();
    await session.settle();
    await session.apply();
    expect(vi.mocked(h.port.apply).mock.calls[0]![1]).toEqual([]);
    expect(h.canonicalHistory).toHaveLength(0);
    expect(h.snapshot.revision).toBe(0);
    expect(h.lease).toBeNull();
  });

  it("invalid drafts retain the last validated text and cannot Apply", async () => {
    const h = harness();
    const session = await h.open((text) => ({ valid: text !== "INVALID", diagnostics: text === "INVALID" ? ["malformed"] : [] }));
    await session.settle();
    const previous = session.lastValidText;
    session.replaceText("INVALID");
    await session.settle();
    expect(session.validation).toEqual({ valid: false, diagnostics: ["malformed"] });
    expect(session.lastValidText).toBe(previous);
    await expect(session.apply()).rejects.toThrow("invalid");
    expect(h.port.apply).not.toHaveBeenCalled();
    expect(h.snapshot.text).toBe("Original **source**.");
    await session.cancel();
  });

  it("rejects a second acquisition without losing an existing modified session", async () => {
    const h = harness();
    const session = await h.open();
    session.replaceText("keep this draft");
    await session.settle();
    await expect(h.open()).rejects.toThrow("resolve current");
    expect(session.text).toBe("keep this draft");
    expect(session.modified).toBe(true);
    expect(h.lease?.text).toBe("keep this draft");
    await session.cancel();
  });

  it("clean sessions can close and be replaced without canonical changes", async () => {
    const h = harness();
    const a = await h.open();
    await a.cancel();
    const b = await h.open();
    expect(a.closed).toBe(true);
    expect(undoDepth(b.state)).toBe(0);
    expect(h.canonicalHistory).toHaveLength(0);
    await b.cancel();
  });

  it("Source changes mark drafts stale; Revert never rebases the opening snapshot", async () => {
    const h = harness();
    const session = await h.open();
    session.replaceText("local draft");
    await session.settle();
    h.sourceEdit("remote content");
    expect(session.isStale).toBe(true);
    expect(session.text).toBe("local draft");
    session.revert();
    await session.settle();
    expect(session.text).toBe("Original **source**.");
    await expect(session.apply()).rejects.toThrow("stale");
    expect(h.snapshot.text).toBe("remote content");
    await session.cancel();
  });

  it("failed Apply preserves local text/history/ownership, and can be retried explicitly", async () => {
    const h = harness();
    const session = await h.open();
    session.replaceText("retained");
    await session.settle();
    const depth = undoDepth(session.state);
    vi.mocked(h.port.apply).mockRejectedValueOnce(new Error("commit failed"));
    await expect(session.apply()).rejects.toThrow("commit failed");
    expect(session.closed).toBe(false);
    expect(session.text).toBe("retained");
    expect(undoDepth(session.state)).toBe(depth);
    expect(h.lease).not.toBeNull();
    expect(renderToStaticMarkup(createElement(InlineSourceEditor, { session }))).toContain(">Retry</button>");
    session.retryValidation();
    await session.settle();
    await session.apply();
    expect(session.closed).toBe(true);
    expect(h.snapshot.text).toBe("retained");
  });

  it("failed cancellation preserves the session for retry", async () => {
    const h = harness();
    const session = await h.open();
    session.replaceText("retained");
    vi.mocked(h.port.release).mockRejectedValueOnce(new Error("offline"));
    await expect(session.cancel()).rejects.toThrow("offline");
    expect(session.text).toBe("retained");
    expect(session.closed).toBe(false);
    await session.cancel();
    expect(session.closed).toBe(true);
  });

  it("stale validation results cannot overwrite a newer result", async () => {
    const h = harness();
    let finish!: (result: { valid: boolean; diagnostics: string[] }) => void;
    const validator = vi.fn((text: string) => text === "slow" ? new Promise<{ valid: boolean; diagnostics: string[] }>((resolve) => { finish = resolve; }) : { valid: true, diagnostics: [] });
    const session = await h.open(validator);
    await session.settle();
    session.replaceText("slow");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    session.replaceText("newest");
    await session.settle();
    finish({ valid: false, diagnostics: ["obsolete"] });
    await Promise.resolve();
    expect(session.validation.valid).toBe(true);
    expect(session.lastValidText).toBe("newest");
    expect(h.lease?.text).toBe("newest");
    await session.cancel();
  });

  it("retrying validation supersedes an older result even when text is unchanged", async () => {
    const h = harness();
    let finish!: (result: { valid: boolean; diagnostics: string[] }) => void;
    const validator = vi.fn<DraftValidator>()
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockReturnValue({ valid: true, diagnostics: [] });
    const session = await h.open(validator);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    session.retryValidation();
    await session.settle();
    finish({ valid: false, diagnostics: ["obsolete retry"] });
    await Promise.resolve();
    expect(session.canApply).toBe(true);
    expect(session.validation.diagnostics).toEqual([]);
    expect(h.lease?.generation).toBe(1);
    await session.cancel();
  });

  it("releases ownership if editor setup cannot establish its observation subscription", async () => {
    const h = harness();
    vi.mocked(h.port.watch).mockImplementationOnce(() => { throw new Error("watch failed"); });
    await expect(h.open()).rejects.toThrow("watch failed");
    expect(h.port.release).toHaveBeenCalledOnce();
    expect(h.lease).toBeNull();
    expect(h.canonicalHistory).toHaveLength(0);
    const retry = await h.open();
    await retry.cancel();
  });

  it("late validation after Cancel cannot resurrect a lease or history", async () => {
    const h = harness();
    let finish!: (result: { valid: boolean; diagnostics: string[] }) => void;
    const session = await h.open(() => new Promise((resolve) => { finish = resolve; }));
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await session.cancel();
    const updates = vi.mocked(h.port.update).mock.calls.length;
    finish({ valid: true, diagnostics: [] });
    await Promise.resolve();
    expect(session.closed).toBe(true);
    expect(h.lease).toBeNull();
    expect(h.port.update).toHaveBeenCalledTimes(updates);
  });

  it("delayed ownership events are confirmed before invalidating the current session", async () => {
    const h = harness();
    const session = await h.open();
    await session.settle();
    h.notify({ lease: null });
    await Promise.resolve();
    expect(session.canApply).toBe(true);
    h.replaceOwner();
    await Promise.resolve();
    expect(session.canApply).toBe(false);
    await session.cancel();
    expect(h.lease?.ownerWindow).toBe("b");
    expect(h.port.release).not.toHaveBeenCalled();
  });

  it("preserves CRLF, CR and mixed endings through real CM history", async () => {
    const h = harness("First\r\nsecond\rthird\nfourth");
    const session = await h.open();
    expect(session.text).toBe(h.snapshot.text);
    session.replaceText(session.text + " CHANGED");
    session.revert();
    expect(session.text).toBe(h.snapshot.text);
    session.undo();
    expect(session.text).toBe(h.snapshot.text + " CHANGED");
    await session.settle();
    await session.apply();
    expect(h.snapshot.text).toBe("First\r\nsecond\rthird\nfourth CHANGED");
  });

  it.each(["\r\n", "\r", "\n"])("new line entry preserves the captured line-ending policy: %j", async (ending) => {
    const h = harness("first" + ending + "second");
    const session = await h.open();
    expect(session.lineEnding).toBe(ending);
    session.dispatch(session.state.update({ selection: { anchor: session.state.doc.length } }));
    session.insertLineBreak();
    expect(session.text).toBe(h.snapshot.text + ending);
    await session.cancel();
  });

  it("failed draft synchronization preserves history and blocks Apply until explicit retry", async () => {
    const h = harness();
    const session = await h.open();
    await session.settle();
    vi.mocked(h.port.update).mockRejectedValueOnce(new Error("sync offline"));
    session.replaceText("retained offline");
    await expect(session.settle()).rejects.toThrow("offline");
    expect(session.canApply).toBe(false);
    expect(session.text).toBe("retained offline");
    expect(undoDepth(session.state)).toBe(1);
    expect(h.port.apply).not.toHaveBeenCalled();
    session.retryValidation();
    await session.settle();
    await session.apply();
    expect(h.snapshot.text).toBe("retained offline");
  });

  it("renders persistent Revert / Cancel / Apply controls and disables invalid Apply", async () => {
    const h = harness();
    const session = await h.open(() => ({ valid: false, diagnostics: ["invalid draft"] }));
    await session.settle();
    const html = renderToStaticMarkup(createElement(InlineSourceEditor, { session }));
    expect(html).toContain("Revert</button>");
    expect(html).toContain("Cancel</button>");
    expect(html).toMatch(/<button disabled="">Apply<\/button>/);
    expect(html).toContain("invalid draft");
    expect(html).not.toContain("Discard</button>");
    await session.cancel();
  });
});
