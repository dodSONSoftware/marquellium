/**
 * Close/quit/reload/mode-switch resolution state machine (ADR-008).
 *
 * Two nested "unsaved work" mechanisms must be resolved in order, with
 * explicit user choices, and a failed or cancelled step must leave all state
 * intact:
 *
 *   S0 introspect  — for each affected document: draft modified? dirty?
 *   S1 drafts      — ModifiedDraft ⇒ modal [Apply | Discard | Cancel trigger]
 *                    CleanDraft    ⇒ closed silently
 *   S2 canonical   — dirty ⇒ [Save | Discard | Cancel trigger]
 *   S3 execute     — the trigger itself
 *
 * Invariants (test-enforced):
 *  - drafts always resolve before canonical state (AT-107),
 *  - a failed Apply/Save keeps the coordinator on the same step (no progress,
 *    no data loss — AT-106 "save failure keeps app/data open"),
 *  - Cancel aborts the WHOLE trigger; nothing after the cancel may run,
 *  - an unchanged draft never produces a modal (§1A.4),
 *  - applying a valid draft that dirties a previously clean document inserts
 *    the canonical step (the save must account for it).
 *
 * The machine is pure bookkeeping: it records the actions the UI must perform
 * (native commands) but does not itself touch documents — so it is trivially
 * unit-testable and cannot lose data by accident.
 */

export type Trigger =
  | "mode-switch"
  | "close-tab"
  | "close-window"
  | "quit"
  | "reload-document";

export type DraftState = "absent" | "clean" | "modified";

export interface DocStateForClose {
  docId: string;
  path: string | null;
  dirty: boolean;
  draft: DraftState;
  /** A modified draft is only applicable while it validates. */
  draftValid: boolean;
  /** Internal: dirty before a draft-Apply (restored if the Apply fails). */
  preApplyDirty?: boolean;
}

export interface Step {
  kind: "draft" | "canonical" | "execute";
  docId?: string;
  /** Display name for the modal (unambiguous filenames, §1B.5). */
  filename: string;
}

export type DraftChoice = "apply" | "discard";
export type CanonicalChoice = "save" | "discard";

export type Action =
  | { type: "close-clean-draft"; docId: string }
  | { type: "draft-applied"; docId: string }
  | { type: "draft-discarded"; docId: string }
  | { type: "saved"; docId: string }
  | { type: "discarded"; docId: string }
  | { type: "execute"; trigger: Trigger }
  | { type: "aborted"; trigger: Trigger };

export class CloseCoordinator {
  private queue: Step[] = [];
  private index = 0;
  private state: "running" | "aborted" | "done" = "running";
  /** Live doc states so draft-Apply can insert the canonical step. */
  private docs = new Map<string, DocStateForClose>();
  readonly actions: Action[] = [];

  constructor(private trigger: Trigger, docs: DocStateForClose[]) {
    for (const d of docs) {
      this.docs.set(d.docId, { ...d });
      if (d.draft === "clean") {
        this.actions.push({ type: "close-clean-draft", docId: d.docId });
      }
      if (d.draft === "modified") {
        this.queue.push({
          kind: "draft",
          docId: d.docId,
          filename: this.name(d),
        });
      }
      if (d.dirty) {
        this.queue.push({
          kind: "canonical",
          docId: d.docId,
          filename: this.name(d),
        });
      }
    }
    this.queue.push({ kind: "execute", filename: "" });
  }

  private name(d: DocStateForClose): string {
    return d.path ? d.path.split(/[\\/]/).pop() ?? d.path : "Untitled";
  }

  get current(): Step | null {
    if (this.state !== "running") return null;
    return this.queue[this.index] ?? null;
  }

  /** True while the trigger needs explicit user resolution. */
  get needsResolution(): boolean {
    return (
      this.state === "running" && (this.queue[this.index]?.kind ?? null) !== "execute"
    );
  }

  get isAborted(): boolean {
    return this.state === "aborted";
  }

  get isDone(): boolean {
    return this.state === "done";
  }

  /** All remaining steps after the current one (for a quit summary sheet). */
  get remaining(): Step[] {
    if (this.state !== "running") return [];
    return this.queue.slice(this.index);
  }

  private advance() {
    this.index += 1;
    // The execute step is always last; landing on it means "safe to run".
  }

  /** The UI has performed the trigger. */
  completeExecution(): boolean {
    const step = this.current;
    if (this.state !== "running" || !step || step.kind !== "execute") {
      return false;
    }
    this.state = "done";
    this.actions.push({ type: "execute", trigger: this.trigger });
    return true;
  }

  /** Modal Apply/Discard for a modified draft. */
  chooseDraft(docId: string, choice: DraftChoice): boolean {
    const step = this.current;
    if (!step || step.kind !== "draft" || step.docId !== docId) return false;
    const doc = this.docs.get(docId);
    if (!doc) return false;
    if (choice === "apply") {
      if (!doc.draftValid) return false; // blocked: invalid drafts cannot apply
      this.actions.push({ type: "draft-applied", docId });
      doc.preApplyDirty = doc.dirty;
      doc.draft = "absent";
      // Applying committed content dirties the document: make sure the
      // canonical step runs before execute.
      if (doc.dirty === false) {
        doc.dirty = true;
        const hasCanonical = this.queue
          .slice(this.index + 1)
          .some((s) => s.kind === "canonical" && s.docId === docId);
        if (!hasCanonical) {
          this.queue.splice(this.index + 1, 0, {
            kind: "canonical",
            docId,
            filename: this.name(doc),
          });
        }
      }
    } else {
      this.actions.push({ type: "draft-discarded", docId });
      doc.draft = "absent";
    }
    this.advance();
    return true;
  }

  /** True iff the coordinator stayed on the draft step (apply failed). */
  draftApplyBlocked(docId: string): boolean {
    const step = this.current;
    if (!step || step.kind !== "draft" || step.docId !== docId) return false;
    const doc = this.docs.get(docId);
    return !!doc && !doc.draftValid;
  }

  /**
   * The native Apply of a previously chosen draft failed (e.g. stale
   * revision from another window): roll the machine back onto the draft
   * step so the user can retry, discard, or cancel. Nothing is lost.
   */
  draftApplyFailed(docId: string): boolean {
    if (this.state !== "running") return false;
    const ai = this.actions.findIndex(
      (a) => a.type === "draft-applied" && a.docId === docId,
    );
    if (ai === -1) return false;
    this.actions.splice(ai, 1);
    this.index -= 1;
    // Remove the canonical step that the apply inserted (if any).
    const qi = this.queue.findIndex(
      (s) => s.kind === "canonical" && s.docId === docId,
    );
    if (qi > this.index) this.queue.splice(qi, 1);
    const doc = this.docs.get(docId);
    if (doc) {
      doc.draft = "modified";
      if (doc.preApplyDirty !== undefined) doc.dirty = doc.preApplyDirty;
    }
    const step = this.current;
    return !!step && step.kind === "draft" && step.docId === docId;
  }

  /** Modal Save/Discard for dirty canonical state. */
  chooseCanonical(docId: string, choice: CanonicalChoice): boolean {
    const step = this.current;
    if (!step || step.kind !== "canonical" || step.docId !== docId) return false;
    const doc = this.docs.get(docId);
    if (!doc) return false;
    if (choice === "save") {
      this.actions.push({ type: "saved", docId });
      doc.dirty = false;
    } else {
      this.actions.push({ type: "discarded", docId });
      doc.dirty = false;
    }
    this.advance();
    return true;
  }

  /**
   * The native Save for a chosen document failed: roll the machine back
   * onto the canonical step so the user can retry, discard, or cancel.
   * Data stays preserved (the document remains dirty).
   */
  saveFailed(docId: string): boolean {
    if (this.state !== "running") return false;
    const ai = this.actions.findIndex(
      (a) => a.type === "saved" && a.docId === docId,
    );
    if (ai === -1) return false;
    this.actions.splice(ai, 1);
    this.index -= 1;
    const doc = this.docs.get(docId);
    if (doc) doc.dirty = true;
    const step = this.current;
    return !!step && step.kind === "canonical" && step.docId === docId;
  }

  /** Abort the entire trigger. No further actions may occur. */
  cancel(): void {
    if (this.state !== "running") return;
    this.state = "aborted";
    this.actions.push({ type: "aborted", trigger: this.trigger });
  }
}
