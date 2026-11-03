/**
 * M3 edit-group regression tests, pinned against the REGISTRY's contract.
 *
 * The mock registry implements `apply_transaction`'s exact semantics:
 * every op in a transaction addresses the PRE-batch buffer, ascending,
 * applied in reverse, with a base-revision check. The bug pinned here:
 * per-keystroke ops are addressed to the document AFTER the previous
 * keystroke (CodeMirror's A-space is per-update), so the store must
 * commit the group's NET diff — sending the accumulated ops raw made the
 * registry apply later ops at stale offsets (scattered characters,
 * phantom newlines) and record a wrong `old_text` (broken undo).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyOps,
  bytesToString,
  stringToBytes,
  type ByteOp,
} from "../../core/ops";
import { ByteIndex, changesToByteOps } from "../../core/positions";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import cases from "../../../fixtures/markdown/m3v/fidelity-cases.json";
import { createSourceMap, type Utf16Offset } from "../../core/source-map";
import type { DraftLease } from "../../core/draft-session";
import { editMappedBlock } from "../../core/localized-edit";
import { DocumentStore } from "./DocumentStore";
import { native } from "../../services/native";
import type { DocumentUpdate } from "../../services/native";

// --- mock registry (Rust contract, verbatim semantics) -----------------------

interface MockDoc {
  content: string;
  revision: number;
  dirty: boolean;
  history: { ops: ByteOp[]; oldTexts: string[] }[];
}

const docs = new Map<string, MockDoc>();
let nextId = 0;
const broadcasts: ((u: DocumentUpdate) => void)[] = [];
const applyCalls: { docId: string; revision: number; ops: ByteOp[] }[] = [];

function spliceBytes(
  bytes: Uint8Array,
  from: number,
  to: number,
  text: string,
): Uint8Array {
  const ins = stringToBytes(text);
  const next = new Uint8Array(bytes.length - (to - from) + ins.length);
  next.set(bytes.subarray(0, from), 0);
  next.set(ins, from);
  next.set(bytes.subarray(to), from + ins.length);
  return next;
}

function registryApply(
  docId: string,
  baseRevision: number,
  ops: ByteOp[],
): DocumentUpdate {
  const d = docs.get(docId);
  if (!d) throw new Error(`unknown document ${docId}`);
  if (baseRevision !== d.revision) {
    throw new Error(`stale revision: expected ${baseRevision}, registry at ${d.revision}`);
  }
  if (ops.length === 0) throw new Error("empty transaction");
  const bytes = stringToBytes(d.content);
  // Validation pass: original buffer, ascending (Rust `apply_transaction`).
  const res = applyOps(bytes, ops);
  if (!res.ok) throw new Error(res.error ?? "invalid op");
  // Record old_text per op (Rust captures it for undo).
  const oldTexts = ops.map((op) =>
    bytesToString(bytes.subarray(op.startByte, op.endByte)),
  );
  // Apply in reverse (Rust contract).
  let next = bytes;
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i]!;
    next = spliceBytes(next, op.startByte, op.endByte, op.text);
  }
  d.content = bytesToString(next);
  d.revision += 1;
  d.dirty = true;
  d.history.push({ ops, oldTexts });
  const update: DocumentUpdate = {
    docId,
    revision: d.revision,
    ops,
    dirty: true,
    kind: "edit",
  };
  applyCalls.push({ docId, revision: baseRevision, ops });
  for (const cb of broadcasts) cb(update);
  return update;
}

function registryUndo(docId: string): DocumentUpdate | null {
  const d = docs.get(docId);
  if (!d) throw new Error(`unknown document ${docId}`);
  const rec = d.history.pop();
  if (!rec) return null;
  let bytes = stringToBytes(d.content);
  let shift = 0;
  const inverse = rec.ops.map((op, i) => {
    const old = rec.oldTexts[i] ?? "";
    const startByte = op.startByte + shift;
    shift += stringToBytes(op.text).length - (op.endByte - op.startByte);
    return { startByte, endByte: startByte + stringToBytes(op.text).length, text: old };
  });
  const undone = applyOps(bytes, inverse);
  if (!undone.ok) throw new Error("invalid mock undo");
  bytes = undone.next;
  d.content = bytesToString(bytes);
  d.revision += 1;
  d.dirty = false;
  const update: DocumentUpdate = {
    docId,
    revision: d.revision,
    ops: inverse,
    dirty: false,
    kind: "undo",
  };
  for (const cb of broadcasts) cb(update);
  return update;
}

vi.mock("../../services/native", () => ({
  onDraftChanged: async () => () => {},
  native: {
    drafts: { apply: vi.fn(), info: vi.fn(), acquire: vi.fn(), update: vi.fn(), release: vi.fn() },
    documents: {
      new: () => {
        const id = `doc-${nextId++}`;
        docs.set(id, { content: "", revision: 0, dirty: false, history: [] });
        return id;
      },
      snapshot: (docId: string) => {
        const d = docs.get(docId);
        if (!d) return null;
        return {
          docId,
          path: null,
          content: d.content,
          bom: false,
          newline: "lf" as const,
          revision: d.revision,
          savedContentHash: null,
          savedDiskRevision: null,
          diskRevision: null,
          dirty: d.dirty,
          draftActive: null,
        };
      },
      open: async (docId: string) => {
        const snapshot = await native.documents.snapshot(docId);
        if (!snapshot) throw new Error(`unknown document ${docId}`);
        return snapshot;
      },
      acquire: () => 1,
      apply: (docId: string, baseRevision: number, ops: ByteOp[]) =>
        registryApply(docId, baseRevision, ops),
      applyLocalized: (docId: string, revision: number, ops: ByteOp[]) => native.documents.apply(docId, revision, ops),
      undo: (docId: string) => registryUndo(docId),
      redo: () => null,
      release: () => 0,
      dispose: () => true,
      reload: () => null,
      save: () => ({ ok: true as const }),
      saveAs: () => ({ ok: true as const }),
      recoverySnapshot: async () => null,
    },
  },
}));

// --- helpers -------------------------------------------------------------------

describe("shared saved metadata", () => {
  it("flushes rather than drops Source edits and pins the revision before automatic reload", async () => {
    const store = new DocumentStore();
    const id = await store.newDocument();
    keystroke(store, id, "", 0, 0, "must not disappear");
    const reload = vi.spyOn(native.documents, "reload").mockRejectedValueOnce(new Error("document changed before reload"));
    await expect(store.reloadFromDisk(id)).rejects.toThrow("changed before reload");
    expect(reload).toHaveBeenCalledWith(id, 1);
    expect(store.content(id)).toBe("must not disappear");
    expect(store.isDirty(id)).toBe(true);
  });
  it("refreshes three mirrors after a remote save without changing text revision or history", async () => {
    const first = new DocumentStore();
    const id = await first.newDocument();
    const second = new DocumentStore(), third = new DocumentStore();
    await second.attachDocument(id);
    await third.attachDocument(id);
    const update = registryApply(id, 0, [{ startByte: 0, endByte: 0, text: "saved text" }]);
    const stores = [first, second, third];
    for (const store of stores) store.applyUpdate(update);
    expect(stores.every((store) => store.isDirty(id))).toBe(true);
    docs.get(id)!.dirty = false;
    await Promise.all(stores.map((store) => store.refreshSavedDocument(id)));
    for (const store of stores) {
      expect(store.isDirty(id)).toBe(false);
      expect(store.content(id)).toBe("saved text");
      expect(store.get(id)?.revision).toBe(1);
    }
    expect(docs.get(id)?.history).toHaveLength(1);
  });

  it("retains a pending Source group when a save notification arrives", async () => {
    const store = new DocumentStore();
    const id = await store.newDocument();
    keystroke(store, id, "", 0, 0, "pending text");
    await store.refreshSavedDocument(id);
    expect(store.isDirty(id)).toBe(true);
    expect(store.projectedText(id)).toBe("pending text");
    await store.flushAll();
    expect(store.content(id)).toBe("pending text");
    expect(store.isDirty(id)).toBe(true);
  });

  it("does not adopt an unrelated document from a save notification", async () => {
    const store = new DocumentStore();
    await store.refreshSavedDocument("not-open-here");
    expect(store.list).toHaveLength(0);
  });
});

/** Simulate one CodeMirror update the way SourceEditor's listener does:
 *  changes in THIS update's A-space (the current view text). */
function keystroke(
  store: DocumentStore,
  docId: string,
  viewText: string,
  from: number,
  to: number,
  inserted: string,
): void {
  const ops = changesToByteOps(new ByteIndex(viewText), [
    { fromA: from, toA: to, inserted },
  ]);
  if (ops === null) throw new Error("unexpected null byte ops");
  store.editGroup(docId, ops);
}

async function openWith(store: DocumentStore, text: string): Promise<string> {
  const id = await store.newDocument();
  await store.editFullContent(id, text);
  return id;
}

function regText(docId: string): string {
  return docs.get(docId)?.content ?? "<missing>";
}

beforeEach(() => {
  docs.clear();
  nextId = 0;
  applyCalls.length = 0;
  broadcasts.length = 0;
});

// --- tests -----------------------------------------------------------------------

describe("edit groups vs the registry contract", () => {
  it("commits a keystroke burst as ONE transaction with the exact net text", async () => {
    const store = new DocumentStore();
    broadcasts.push((u) => store.applyUpdate(u));
    const id = await openWith(store, "hello world");
    const baseCalls = applyCalls.length;

    // Type "abc" after "hello": each keystroke is addressed to the
    // document AFTER the previous one (evolving CM A-space).
    let v = "hello world";
    keystroke(store, id, v, 5, 5, "a");
    v = v.slice(0, 5) + "a" + v.slice(5);
    keystroke(store, id, v, 6, 6, "b");
    v = v.slice(0, 6) + "b" + v.slice(6);
    keystroke(store, id, v, 7, 7, "c");
    v = v.slice(0, 7) + "c" + v.slice(7);

    await store.flushGroup(id);

    // One registry transaction (coalesced burst), and its net effect is
    // exactly the view's text.
    expect(applyCalls.length).toBe(baseCalls + 1);
    expect(regText(id)).toBe("helloabc world");
    expect(bytesToString(store.get(id)!.bytes)).toBe("helloabc world");
  });

  it("delete-then-type lands characters where the view has them (no scatter, no phantom newline)", async () => {
    const store = new DocumentStore();
    broadcasts.push((u) => store.applyUpdate(u));
    const id = await openWith(store, "hello world");

    // Backspace at position 5 (deletes "o"), then type "X" at the end.
    let v = "hello world";
    keystroke(store, id, v, 4, 5, ""); // delete "o"
    v = v.slice(0, 4) + v.slice(5); // "hell world"
    keystroke(store, id, v, 10, 10, "X"); // end of "hell world"
    v = v + "X"; // "hell worldX"

    await store.flushGroup(id);

    expect(regText(id)).toBe("hell worldX");
    expect(bytesToString(store.get(id)!.bytes)).toBe("hell worldX");
  });

  it("undo restores the pre-group text exactly (old_text was the regression)", async () => {
    const store = new DocumentStore();
    broadcasts.push((u) => store.applyUpdate(u));
    const id = await openWith(store, "hello world");

    let v = "hello world";
    keystroke(store, id, v, 4, 5, "");
    v = v.slice(0, 4) + v.slice(5);
    keystroke(store, id, v, 10, 10, "X");

    await store.flushGroup(id);
    expect(regText(id)).toBe("hell worldX");

    await store.undo(id);
    expect(regText(id)).toBe("hello world");
    expect(bytesToString(store.get(id)!.bytes)).toBe("hello world");
  });

  it("type + delete netting to zero sends no transaction", async () => {
    const store = new DocumentStore();
    broadcasts.push((u) => store.applyUpdate(u));
    const id = await openWith(store, "x");
    const baseCalls = applyCalls.length;

    let v = "x";
    keystroke(store, id, v, 1, 1, "a");
    v = "xa";
    keystroke(store, id, v, 1, 2, "");
    v = "x";

    await store.flushGroup(id);
    expect(applyCalls.length).toBe(baseCalls);
    expect(regText(id)).toBe("x");
  });

  it("surrogate-safe: typing around an emoji keeps the pair intact", async () => {
    const store = new DocumentStore();
    broadcasts.push((u) => store.applyUpdate(u));
    const id = await openWith(store, "a🎉b"); // a, [D83C DF89], b

    // Type "X" just after the emoji (code-unit position 3).
    let v = "a🎉b";
    keystroke(store, id, v, 3, 3, "X");
    v = v.slice(0, 3) + "X" + v.slice(3); // "a🎉Xb"

    await store.flushGroup(id);
    expect(regText(id)).toBe("a🎉Xb");
  });
});

describe("document lifecycle barriers", () => {
  it("reports uncommitted typing as dirty for close resolution", async () => {
    const store = new DocumentStore();
    const id = await store.newDocument();
    expect(store.isDirty(id)).toBe(false);
    keystroke(store, id, "", 0, 0, "unsaved");
    expect(store.isDirty(id)).toBe(true);
    await store.flushGroup(id);
  });

  it("save waits for a commit already dispatched by the timer", async () => {
    vi.useFakeTimers();
    const store = new DocumentStore();
    const id = await store.newDocument();
    let complete!: () => void;
    const apply = vi.spyOn(native.documents, "apply").mockImplementation(
      (docId, revision, ops) => new Promise((resolve) => {
        complete = () => resolve(registryApply(docId, revision, ops));
      }),
    );
    const save = vi.spyOn(native.documents, "save");
    try {
      keystroke(store, id, "", 0, 0, "typed");
      await vi.advanceTimersByTimeAsync(100);
      expect(store.isDirty(id)).toBe(true);
      const saving = store.save(id);
      await Promise.resolve();
      expect(save).not.toHaveBeenCalled();
      complete();
      await saving;
      expect(save).toHaveBeenCalledOnce();
      expect(store.content(id)).toBe("typed");
    } finally {
      apply.mockRestore();
      save.mockRestore();
      vi.useRealTimers();
    }
  });

  it("ignores a broadcast delivered after the same revision was acknowledged", async () => {
    const store = new DocumentStore();
    const id = await store.newDocument();
    keystroke(store, id, "", 0, 0, "once");
    await store.flushGroup(id);
    store.applyUpdate({ docId: id, revision: 1, ops: applyCalls[0]!.ops, dirty: true, kind: "edit" });
    expect(store.content(id)).toBe("once");
  });

  it("failed edit commits prevent saving and remain unresolved", async () => {
    const store = new DocumentStore();
    const id = await store.newDocument();
    const apply = vi.spyOn(native.documents, "apply").mockRejectedValue(new Error("IPC failed"));
    const save = vi.spyOn(native.documents, "save");
    try {
      keystroke(store, id, "", 0, 0, "typed");
      expect((await store.save(id)).ok).toBe(false);
      expect(save).not.toHaveBeenCalled();
      expect(store.isDirty(id)).toBe(true);
    } finally {
      apply.mockRestore();
      save.mockRestore();
    }
  });
});


describe("localized canonical transactions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function capturedEdit(store: DocumentStore, id: string, replacement: string) {
    const snapshot = await store.captureSourceSnapshot(id);
    const map = createSourceMap(snapshot);
    return editMappedBlock(map, map.blocks[0]!, replacement);
  }

  it.each(cases)("submits one canonical transaction with exact fixture bytes: $name", async (fixture) => {
    const root = join(__dirname, "../../../fixtures/markdown");
    const bytes = readFileSync(join(root, fixture.input));
    const bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
    const text = new TextDecoder("utf8", { ignoreBOM: true }).decode(bytes.subarray(bom ? 3 : 0));
    const store = new DocumentStore();
    broadcasts.push((update) => store.applyUpdate(update));
    const id = await openWith(store, text);
    const doc = store.get(id)!;
    doc.bom = bom;
    doc.newline = text.includes("\r\n") ? "crlf" : "lf";
    const metadata = { bom: doc.bom, newline: doc.newline, path: doc.path };
    const map = createSourceMap(await store.captureSourceSnapshot(id));
    const block = map.blocks.find((b) => b.node.type === fixture.blockType && b.source.includes(fixture.original))!;
    const edit = editMappedBlock(map, block, block.source.replace(fixture.original, fixture.replacement));
    const calls = applyCalls.length;
    const depth = docs.get(id)!.history.length;
    await store.applyLocalizedEdit(edit);
    expect(applyCalls).toHaveLength(calls + 1);
    expect(applyCalls.at(-1)!.revision).toBe(edit.baseRevision);
    expect(applyCalls.at(-1)!.ops).toHaveLength(1);
    expect(docs.get(id)!.history).toHaveLength(depth + 1);
    expect(store.get(id)!.dirty).toBe(true);
    expect({ bom: doc.bom, newline: doc.newline, path: doc.path }).toEqual(metadata);
    expect(Buffer.concat([bytes.subarray(0, bom ? 3 : 0), Buffer.from(store.get(id)!.bytes)]))
      .toEqual(readFileSync(join(root, fixture.expected)));
    await store.undo(id);
    expect(store.content(id)).toBe(text);
  });

  it("no-op requests do not submit, dirty, or add history", async () => {
    const store = new DocumentStore();
    const id = await store.newDocument();
    const apply = vi.spyOn(native.documents, "apply");
    const recovery = vi.spyOn(native.documents, "recoverySnapshot");
    const edit = {
      docId: id, baseRevision: 0,
      authorizedRange: { docId: id, revision: 0, from: 0 as Utf16Offset, to: 0 as Utf16Offset },
      range: { docId: id, revision: 0, from: 0 as Utf16Offset, to: 0 as Utf16Offset },
      openingText: "", replacementText: "",
    };
    await store.applyLocalizedEdit(edit);
    expect(apply).not.toHaveBeenCalled();
    expect(recovery).not.toHaveBeenCalled();
    expect(store.isDirty(id)).toBe(false);
    expect(store.get(id)!.revision).toBe(0);
    expect(docs.get(id)!.history).toHaveLength(0);
  });

  it("awaits a timer-dispatched Source group before capturing mapping input", async () => {
    vi.useFakeTimers();
    const store = new DocumentStore();
    const id = await openWith(store, "x");
    let complete!: () => void;
    vi.spyOn(native.documents, "apply").mockImplementation((docId, revision, ops) =>
      new Promise((resolve) => { complete = () => resolve(registryApply(docId, revision, ops)); }),
    );
    keystroke(store, id, "x", 1, 1, "y");
    await vi.advanceTimersByTimeAsync(100);
    let captured = false;
    const pending = store.captureSourceSnapshot(id).then((snapshot) => { captured = true; return snapshot; });
    await Promise.resolve();
    expect(captured).toBe(false);
    complete();
    expect(await pending).toEqual({ docId: id, revision: 2, text: "xy" });
  });

  it("flushes Source edits then rejects the now-stale localized request", async () => {
    const store = new DocumentStore();
    const id = await openWith(store, "text");
    const edit = await capturedEdit(store, id, "localized");
    const calls = applyCalls.length;
    keystroke(store, id, "text", 4, 4, "!");
    await expect(store.applyLocalizedEdit(edit)).rejects.toThrow("stale");
    expect(regText(id)).toBe("text!");
    expect(applyCalls).toHaveLength(calls + 1);
    expect(applyCalls.at(-1)!.ops[0]!.text).toBe("!");
  });

  it("pins queued localized edits to their captured revision instead of rebasing", async () => {
    const store = new DocumentStore();
    const id = await openWith(store, "base");
    const first = await capturedEdit(store, id, "first");
    const second = await capturedEdit(store, id, "second");
    const calls = applyCalls.length;
    const results = await Promise.allSettled([store.applyLocalizedEdit(first), store.applyLocalizedEdit(second)]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(applyCalls).toHaveLength(calls + 1);
    expect(regText(id)).toBe("first");
  });

  it("keeps immediate save, snapshot capture and flushAll behind the full localized operation", async () => {
    const store = new DocumentStore();
    const id = await openWith(store, "base");
    const edit = await capturedEdit(store, id, "changed");
    let complete!: () => void;
    vi.spyOn(native.documents, "apply").mockImplementation((docId, revision, ops) =>
      new Promise((resolve) => { complete = () => resolve(registryApply(docId, revision, ops)); }),
    );
    const savingNative = vi.spyOn(native.documents, "save");
    store.get(id)!.dirty = false;
    docs.get(id)!.dirty = false;
    const applying = store.applyLocalizedEdit(edit);
    expect(store.isDirty(id)).toBe(true);
    const saving = store.save(id);
    let flushed = false;
    const flushing = store.flushAll().then(() => { flushed = true; });
    const capturing = store.captureSourceSnapshot(id);
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    await Promise.resolve();
    expect(savingNative).not.toHaveBeenCalled();
    expect(flushed).toBe(false);
    complete();
    await Promise.all([applying, saving, flushing]);
    expect((await capturing).text).toBe("changed");
    expect(savingNative).toHaveBeenCalledOnce();
  });

  it("propagates registry rejection and preserves a remote winner without retry", async () => {
    const store = new DocumentStore();
    const id = await openWith(store, "base");
    const edit = await capturedEdit(store, id, "local");
    const apply = vi.spyOn(native.documents, "apply").mockImplementation((docId, revision, ops) => {
      registryApply(docId, revision, [{ startByte: 0, endByte: 0, text: "remote " }]);
      return Promise.resolve(registryApply(docId, revision, ops));
    });
    await expect(store.applyLocalizedEdit(edit)).rejects.toThrow("stale revision");
    expect(apply).toHaveBeenCalledOnce();
    expect(store.content(id)).toBe("remote base");
    expect(regText(id)).toBe("remote base");
  });

  it("propagates transport failure without changing bytes, revision, dirty state or history", async () => {
    const store = new DocumentStore();
    const id = await openWith(store, "base");
    const edit = await capturedEdit(store, id, "local");
    const before = { ...store.get(id)!, bytes: store.get(id)!.bytes.slice() };
    const depth = docs.get(id)!.history.length;
    vi.spyOn(native.documents, "apply").mockRejectedValue(new Error("IPC offline"));
    await expect(store.applyLocalizedEdit(edit)).rejects.toThrow("IPC offline");
    expect(store.get(id)).toEqual(before);
    expect(docs.get(id)!.history).toHaveLength(depth);
  });

  it("rejects invalid captured source before native dispatch without changing document state", async () => {
    const store = new DocumentStore();
    const id = await openWith(store, "base");
    const edit = await capturedEdit(store, id, "local");
    const before = { ...store.get(id)!, bytes: store.get(id)!.bytes.slice() };
    const depth = docs.get(id)!.history.length;
    const apply = vi.spyOn(native.documents, "apply");
    await expect(store.applyLocalizedEdit({ ...edit, openingText: "wrong" })).rejects.toThrow("opening text");
    expect(apply).not.toHaveBeenCalled();
    expect(store.get(id)).toEqual(before);
    expect(docs.get(id)!.history).toHaveLength(depth);
  });

  it("reconciles a successful acknowledgement after resync replaces the mirror object", async () => {
    const store = new DocumentStore();
    const id = await openWith(store, "base");
    const edit = await capturedEdit(store, id, "local");
    let complete!: () => void;
    vi.spyOn(native.documents, "apply").mockImplementation((docId, revision, ops) =>
      new Promise((resolve) => { complete = () => resolve(registryApply(docId, revision, ops)); }),
    );
    const applying = store.applyLocalizedEdit(edit);
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    const before = store.get(id);
    // A saved-metadata refresh replaces the mirror object without waiting
    // for this delayed acknowledgement, unlike a destructive reload.
    await store.refreshSavedDocument(id);
    expect(store.get(id)).not.toBe(before);
    complete();
    await applying;
    expect(store.content(id)).toBe("local");
    expect(regText(id)).toBe("local");
    expect(store.get(id)!.revision).toBe(edit.baseRevision + 1);
  });

  it("rejects rather than hanging when a rejected transaction cannot resync", async () => {
    const store = new DocumentStore();
    const id = await openWith(store, "base");
    const edit = await capturedEdit(store, id, "local");
    vi.spyOn(native.documents, "apply").mockRejectedValue(new Error("stale revision"));
    vi.spyOn(native.documents, "snapshot").mockRejectedValue(new Error("snapshot unavailable"));
    await expect(store.applyLocalizedEdit(edit)).rejects.toThrow("resync failed");
    expect(store.content(id)).toBe("base");
    // The failed queue entry must not leave a permanently pending barrier.
    await store.flushAll();
  });

  it("copies the request before asynchronous flushing", async () => {
    const store = new DocumentStore();
    const id = await openWith(store, "base");
    const original = await capturedEdit(store, id, "intended");
    const mutable = { ...original, range: { ...original.range }, authorizedRange: { ...original.authorizedRange } };
    const applying = store.applyLocalizedEdit(mutable);
    mutable.replacementText = "mutated";
    mutable.range.revision = 99;
    await applying;
    expect(regText(id)).toBe("intended");
  });

  it("broadcasts the localized change to another mirror exactly once", async () => {
    const a = new DocumentStore();
    const id = await openWith(a, "base");
    const b = new DocumentStore();
    await b.openDocument(id);
    broadcasts.push((update) => { a.applyUpdate(update); b.applyUpdate(update); });
    const edit = await capturedEdit(a, id, "changed");
    await a.applyLocalizedEdit(edit);
    expect(a.content(id)).toBe("changed");
    expect(b.content(id)).toBe("changed");
    expect(a.get(id)!.revision).toBe(b.get(id)!.revision);
    expect(a.get(id)!.dirty).toBe(true);
    expect(b.get(id)!.dirty).toBe(true);
    await a.undo(id);
    expect(a.content(id)).toBe("base");
    expect(b.content(id)).toBe("base");
  });
});


describe("draft command queue integration", () => {
  afterEach(() => vi.restoreAllMocks());
  const leaseFor = (id: string, revision: number): DraftLease => ({
    docId: id, token: "lease", ownerWindow: "a", generation: 1, text: "changed", valid: true,
    opening: { baseRevision: revision, startByte: 0, endByte: 4, openingText: "base", kind: "source" },
  });

  it("atomic draft Apply acknowledges through the mirror without the ordinary Source command", async () => {
    const store = new DocumentStore();
    const id = await openWith(store, "base");
    const lease = leaseFor(id, store.get(id)!.revision);
    const apply = vi.spyOn(native.drafts, "apply").mockImplementation((docId, _token, _generation, ops) =>
      Promise.resolve(registryApply(docId, lease.opening.baseRevision, ops)),
    );
    const ordinary = vi.spyOn(native.documents, "apply");
    await store.draftPort.apply(lease, [{ startByte: 0, endByte: 4, text: "changed" }]);
    expect(apply).toHaveBeenCalledExactlyOnceWith(id, "lease", 1, [{ startByte: 0, endByte: 4, text: "changed" }]);
    expect(ordinary).not.toHaveBeenCalled();
    expect(store.content(id)).toBe("changed");
    expect(store.get(id)!.revision).toBe(lease.opening.baseRevision + 1);
  });

  it("unchanged Apply still calls the lease-release commit even with zero operations", async () => {
    const store = new DocumentStore();
    const id = await openWith(store, "base");
    const lease = leaseFor(id, store.get(id)!.revision);
    const apply = vi.spyOn(native.drafts, "apply").mockResolvedValue(null);
    const depth = docs.get(id)!.history.length;
    await store.draftPort.apply(lease, []);
    expect(apply).toHaveBeenCalledExactlyOnceWith(id, "lease", 1, []);
    expect(docs.get(id)!.history).toHaveLength(depth);
    expect(store.get(id)!.revision).toBe(lease.opening.baseRevision);
  });

  it("rejects stale draft commits after Source flushing without sending the draft command", async () => {
    const store = new DocumentStore();
    const id = await openWith(store, "base");
    const lease = leaseFor(id, store.get(id)!.revision);
    const apply = vi.spyOn(native.drafts, "apply").mockResolvedValue(null);
    apply.mockClear();
    keystroke(store, id, "base", 4, 4, "!");
    await expect(store.draftPort.apply(lease, [{ startByte: 0, endByte: 4, text: "changed" }])).rejects.toThrow("stale");
    expect(apply).not.toHaveBeenCalled();
    expect(store.content(id)).toBe("base!");
  });

  it("a delayed older snapshot cannot regress a newer mirrored revision during draft refresh", async () => {
    const store = new DocumentStore();
    const id = await openWith(store, "base");
    const oldSnapshot = await native.documents.snapshot(id);
    let complete!: () => void;
    vi.spyOn(native.documents, "snapshot").mockImplementationOnce(() =>
      new Promise((resolve) => { complete = () => resolve(oldSnapshot); }),
    );
    const capturing = store.draftPort.snapshot(id);
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    const update = registryApply(id, 1, [{ startByte: 0, endByte: 0, text: "remote " }]);
    store.applyUpdate(update);
    complete();
    expect(await capturing).toEqual({ docId: id, revision: 2, text: "remote base" });
  });

  it("refreshes canonical snapshot before opening or applying a draft", async () => {
    const store = new DocumentStore();
    const id = await openWith(store, "base");
    registryApply(id, 1, [{ startByte: 0, endByte: 0, text: "remote " }]);
    expect(store.content(id)).toBe("base");
    expect(await store.draftPort.snapshot(id)).toEqual({ docId: id, revision: 2, text: "remote base" });
  });
});
