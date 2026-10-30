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
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyOps,
  bytesToString,
  stringToBytes,
  type ByteOp,
} from "../../core/ops";
import { ByteIndex, changesToByteOps } from "../../core/positions";
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
  // Invert in reverse op order (Rust `undo`).
  for (let i = rec.ops.length - 1; i >= 0; i--) {
    const op = rec.ops[i]!;
    const old = rec.oldTexts[i] ?? "";
    const newEnd = op.startByte + stringToBytes(op.text).length;
    bytes = spliceBytes(bytes, op.startByte, newEnd, old);
  }
  d.content = bytesToString(bytes);
  d.revision += 1;
  d.dirty = false;
  const update: DocumentUpdate = {
    docId,
    revision: d.revision,
    ops: rec.ops,
    dirty: false,
    kind: "undo",
  };
  for (const cb of broadcasts) cb(update);
  return update;
}

vi.mock("../../services/native", () => ({
  native: {
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
      acquire: () => 1,
      apply: (docId: string, baseRevision: number, ops: ByteOp[]) =>
        registryApply(docId, baseRevision, ops),
      undo: (docId: string) => registryUndo(docId),
      redo: () => null,
      release: () => 0,
      dispose: () => true,
      reload: () => null,
      save: () => ({ ok: true as const }),
      saveAs: () => ({ ok: true as const }),
      recoverySnapshot: () => null,
    },
  },
}));

// --- helpers -------------------------------------------------------------------

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
