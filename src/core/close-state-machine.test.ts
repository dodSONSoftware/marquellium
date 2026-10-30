/**
 * M1 — close/quit resolution state machine tests (ADR-008).
 * Covers AT-105, AT-106, AT-107, AT-108 (prompt order, cancel safety,
 * save-failure semantics) and §1A.4/§1A.5.6 (clean drafts never prompt;
 * mode-switch modal semantics).
 */
import { describe, expect, it } from "vitest";
import { CloseCoordinator, type DocStateForClose } from "./close-state-machine";

const doc = (over: Partial<DocStateForClose> = {}): DocStateForClose => ({
  docId: over.docId ?? "doc-1",
  path: over.path ?? null,
  dirty: over.dirty ?? false,
  draft: over.draft ?? "absent",
  draftValid: over.draftValid ?? true,
});

describe("clean documents", () => {
  it("execute immediately — no resolution needed", () => {
    const c = new CloseCoordinator("close-tab", [doc()]);
    expect(c.needsResolution).toBe(false);
    expect(c.current?.kind).toBe("execute");
    expect(c.completeExecution()).toBe(true);
    expect(c.actions).toEqual([{ type: "execute", trigger: "close-tab" }]);
  });

  it("clean drafts close silently without a modal (§1A.4)", () => {
    const c = new CloseCoordinator("mode-switch", [doc({ draft: "clean" })]);
    expect(c.needsResolution).toBe(false);
    expect(c.actions).toContainEqual({
      type: "close-clean-draft",
      docId: "doc-1",
    });
  });
});

describe("dirty documents (AT-105)", () => {
  it("Save resolves, then executes", () => {
    const c = new CloseCoordinator("close-tab", [doc({ dirty: true })]);
    expect(c.needsResolution).toBe(true);
    expect(c.current).toMatchObject({ kind: "canonical", docId: "doc-1" });
    expect(c.chooseCanonical("doc-1", "save")).toBe(true);
    expect(c.completeExecution()).toBe(true);
    expect(c.actions.map((a) => a.type)).toEqual(["saved", "execute"]);
  });

  it("Discard resolves, then executes", () => {
    const c = new CloseCoordinator("close-window", [doc({ dirty: true })]);
    c.chooseCanonical("doc-1", "discard");
    c.completeExecution();
    expect(c.actions.map((a) => a.type)).toEqual(["discarded", "execute"]);
  });

  it("Cancel aborts: nothing runs, state intact (AT-105)", () => {
    const c = new CloseCoordinator("close-tab", [
      doc({ dirty: true, path: "/a/b.md" }),
      doc({ docId: "doc-2", dirty: true, path: "/a/c.md" }),
    ]);
    c.cancel();
    expect(c.isAborted).toBe(true);
    expect(c.needsResolution).toBe(false);
    // only the abort action; no save/discard/execute
    expect(c.actions).toEqual([{ type: "aborted", trigger: "close-tab" }]);
    expect(c.completeExecution()).toBe(false);
  });

  it("save failure keeps the coordinator on the same step (AT-106)", () => {
    const c = new CloseCoordinator("quit", [doc({ dirty: true })]);
    c.chooseCanonical("doc-1", "save");
    // UI reports the save failed:
    expect(c.saveFailed("doc-1")).toBe(true);
    expect(c.current).toMatchObject({ kind: "canonical", docId: "doc-1" });
    expect(c.needsResolution).toBe(true);
    // retry save, then proceed
    c.chooseCanonical("doc-1", "save");
    expect(c.current?.kind).toBe("execute");
    c.completeExecution();
  });

  it("quit walks every dirty document in order (AT-106)", () => {
    const c = new CloseCoordinator("quit", [
      doc({ docId: "a", dirty: true }),
      doc({ docId: "b", dirty: true }),
      doc({ docId: "c" }),
    ]);
    expect(c.current?.docId).toBe("a");
    c.chooseCanonical("a", "save");
    expect(c.current?.docId).toBe("b");
    c.chooseCanonical("b", "discard");
    expect(c.current?.kind).toBe("execute");
    c.completeExecution();
    expect(c.actions.map((a) => a.type)).toEqual(["saved", "discarded", "execute"]);
  });
});

describe("inline drafts (AT-107, §1A.5.6)", () => {
  it("draft resolves BEFORE canonical state (AT-107)", () => {
    const c = new CloseCoordinator("quit", [doc({ dirty: true, draft: "modified" })]);
    expect(c.current).toMatchObject({ kind: "draft", docId: "doc-1" });
    c.chooseDraft("doc-1", "discard");
    expect(c.current).toMatchObject({ kind: "canonical", docId: "doc-1" });
    c.chooseCanonical("doc-1", "save");
    c.completeExecution();
    expect(c.actions.map((a) => a.type)).toEqual([
      "draft-discarded",
      "saved",
      "execute",
    ]);
  });

  it("invalid draft cannot apply; Discard or cancel remain (AT-112/§1A.4)", () => {
    const c = new CloseCoordinator(
      "mode-switch",
      [doc({ draft: "modified", draftValid: false })],
    );
    expect(c.draftApplyBlocked("doc-1")).toBe(true);
    expect(c.chooseDraft("doc-1", "apply")).toBe(false); // blocked
    expect(c.current?.kind).toBe("draft"); // still on the step
    c.chooseDraft("doc-1", "discard");
    expect(c.current?.kind).toBe("execute");
  });

  it("applying a draft that dirties a clean doc inserts the canonical step", () => {
    const c = new CloseCoordinator("close-tab", [
      doc({ dirty: false, draft: "modified" }),
    ]);
    expect(c.current?.kind).toBe("draft");
    c.chooseDraft("doc-1", "apply");
    // the apply committed content: canonical must resolve before execute
    expect(c.current).toMatchObject({ kind: "canonical", docId: "doc-1" });
    c.chooseCanonical("doc-1", "save");
    c.completeExecution();
    expect(c.actions.map((a) => a.type)).toEqual(["draft-applied", "saved", "execute"]);
  });

  it("mode switch with modified draft: cancel switch aborts, draft intact (AT-112)", () => {
    const c = new CloseCoordinator("mode-switch", [
      doc({ draft: "modified" }),
    ]);
    expect(c.needsResolution).toBe(true);
    c.cancel();
    expect(c.isAborted).toBe(true);
    expect(c.actions).toEqual([{ type: "aborted", trigger: "mode-switch" }]);
  });

  it("mode switch with clean draft switches immediately (§1A.4)", () => {
    const c = new CloseCoordinator("mode-switch", [doc({ draft: "clean" })]);
    expect(c.needsResolution).toBe(false);
    expect(c.completeExecution()).toBe(true);
  });

  it("multiple documents: draft of doc 1, then canonical of doc 1, then doc 2", () => {
    const c = new CloseCoordinator("quit", [
      doc({ docId: "a", draft: "modified" }),
      doc({ docId: "b", dirty: true }),
    ]);
    // order: a-draft, b-canonical? NO — per document: a-draft, then
    // (a not dirty) then b-canonical. The machine serializes per doc.
    expect(c.current).toMatchObject({ kind: "draft", docId: "a" });
    c.chooseDraft("a", "apply"); // a now dirty ⇒ canonical(a) inserted
    expect(c.current).toMatchObject({ kind: "canonical", docId: "a" });
    c.chooseCanonical("a", "save");
    expect(c.current).toMatchObject({ kind: "canonical", docId: "b" });
    c.chooseCanonical("b", "discard");
    c.completeExecution();
  });
});
