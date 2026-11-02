/** Isolated CodeMirror draft state. Validation/preview engines are supplied by adapters. */
import { EditorState, Text, type Transaction } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, isolateHistory, undo, redo } from "@codemirror/commands";
import { keymap } from "@codemirror/view";
import { ByteIndex, assertWellFormedText } from "./positions";
import { prepareLocalizedEdit } from "./localized-edit";
import type { ByteOp } from "./ops";
import { assertCurrentSourceMap, type DocumentSourceMap, type MappedBlock, type SourceSnapshot } from "./source-map";

export type DraftKind = "table" | "mermaid" | "source";
export interface DraftOpening {
  baseRevision: number;
  startByte: number;
  endByte: number;
  openingText: string;
  kind: DraftKind;
}
export interface DraftLease {
  docId: string;
  token: string;
  ownerWindow: string | null;
  opening: DraftOpening;
  generation: number;
  text: string;
  valid: boolean;
}
export interface DraftValidation { valid: boolean; diagnostics: readonly string[] }
export type DraftObservation = { snapshot: SourceSnapshot } | { lease: DraftLease | null } | { error: string };
export interface DraftPort {
  snapshot(docId: string): Promise<SourceSnapshot>;
  info(docId: string): Promise<DraftLease | null>;
  acquire(docId: string, opening: DraftOpening): Promise<DraftLease>;
  update(docId: string, token: string, update: { generation: number; text: string; valid: boolean }): Promise<DraftLease>;
  release(docId: string, token: string): Promise<void>;
  apply(lease: DraftLease, ops: ByteOp[]): Promise<void>;
  watch(docId: string, listener: (event: DraftObservation) => void): () => void;
}
export type DraftValidator = (text: string) => DraftValidation | Promise<DraftValidation>;

function preferredLineEnding(opening: string, canonical: string): string {
  const endings = (/[\r\n]/.test(opening) ? opening : canonical).match(/\r\n|\r|\n/g) ?? [];
  const crlf = endings.filter((ending) => ending === "\r\n").length;
  const lf = endings.filter((ending) => ending === "\n").length;
  const cr = endings.length - crlf - lf;
  return crlf && crlf >= lf && crlf >= cr ? "\r\n" : lf >= cr ? "\n" : "\r";
}

export class DraftSession {
  private editor: EditorState | null;
  readonly lineEnding: string;
  private listeners = new Set<(transaction?: Transaction) => void>();
  private unwatch: (() => void) | null = null;
  private generation: number;
  private validationTask: Promise<void> = Promise.resolve();
  private syncTail: Promise<void> = Promise.resolve();
  private applying = false;
  private terminal = false;
  private lostOwnership = false;
  private validity: DraftValidation = { valid: false, diagnostics: ["Validation pending"] };
  private synchronizationError: string | null = null;
  private stale = false;
  private lastValid: string | null = null;

  private constructor(
    private lease: DraftLease,
    private readonly snapshot: SourceSnapshot,
    private readonly block: MappedBlock,
    private readonly port: DraftPort,
    private readonly validate: DraftValidator,
  ) {
    this.generation = lease.generation;
    this.lineEnding = preferredLineEnding(lease.opening.openingText, snapshot.text);
    // CM's default string loader normalizes CRLF/CR. Text plus an explicit LF
    // separator preserves raw CR characters and mixed endings in draft history.
    this.editor = EditorState.create({
      doc: Text.of(lease.text.split("\n")),
      extensions: [
        // Session history is intentionally unbounded; it is discarded at close.
        history({ minDepth: Number.POSITIVE_INFINITY }),
        keymap.of([
          ...historyKeymap,
          { key: "Enter", run: () => { this.insertLineBreak(); return true; } },
          ...defaultKeymap,
        ]),
        EditorState.lineSeparator.of("\n"),
      ],
    });
  }

  static async open(map: DocumentSourceMap, block: MappedBlock, kind: DraftKind, port: DraftPort, validate: DraftValidator): Promise<DraftSession> {
    if (!map.blocks.includes(block)) throw new Error("draft block belongs to another map");
    const snapshot = Object.freeze({ ...await port.snapshot(map.snapshot.docId) });
    assertCurrentSourceMap(map, snapshot);
    const index = new ByteIndex(snapshot.text);
    const startByte = index.byteOffset(block.range.from);
    const endByte = index.byteOffset(block.range.to);
    if (startByte === null || endByte === null) throw new Error("unsafe draft opening range");
    const lease = await port.acquire(snapshot.docId, {
      baseRevision: snapshot.revision, startByte, endByte, openingText: block.source, kind,
    });
    let session: DraftSession;
    try {
      session = new DraftSession(lease, snapshot, block, port, validate);
      session.unwatch = port.watch(snapshot.docId, (event) => session.observe(event));
    } catch (error) {
      try { await port.release(lease.docId, lease.token); }
      catch (releaseError) { throw new AggregateError([error, releaseError], "draft setup failed and lease cleanup failed"); }
      throw error;
    }
    session.revalidate();
    return session;
  }

  get state(): EditorState {
    if (!this.editor) throw new Error("draft history was destroyed");
    return this.editor;
  }
  get text(): string { return this.state.doc.toString(); }
  get openingText(): string { return this.block.source; }
  get modified(): boolean { return !this.closed && this.text !== this.openingText; }
  get closed(): boolean { return this.editor === null; }
  get busy(): boolean { return this.applying; }
  get isStale(): boolean { return this.stale; }
  get validation(): DraftValidation { return this.validity; }
  get lastValidText(): string | null { return this.lastValid; }
  get error(): string | null { return this.synchronizationError; }
  get canRetry(): boolean { return !this.closed && !this.busy && !this.stale && !this.lostOwnership; }
  get canApply(): boolean { return !this.closed && !this.busy && !this.stale && !this.lostOwnership && this.validity.valid && !this.error; }

  subscribe(listener: (transaction?: Transaction) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(transaction?: Transaction): void { for (const listener of this.listeners) listener(transaction); }

  dispatch(transaction: Transaction): void {
    if (this.busy || this.closed) throw new Error("draft is busy or closed");
    if (transaction.startState !== this.state) throw new Error("stale draft transaction");
    assertWellFormedText(transaction.state.doc.toString());
    this.editor = transaction.state;
    if (transaction.docChanged) { this.generation++; this.revalidate(); }
    this.emit(transaction);
  }
  replaceText(text: string): void {
    assertWellFormedText(text);
    this.dispatch(this.state.update({ changes: { from: 0, to: this.state.doc.length, insert: Text.of(text.split("\n")) }, annotations: isolateHistory.of("full") }));
  }
  insertLineBreak(): void { this.dispatch(this.state.update(this.state.replaceSelection(this.lineEnding))); }
  revert(): void { this.replaceText(this.openingText); }
  undo(): boolean { return undo({ state: this.state, dispatch: (transaction) => this.dispatch(transaction) }); }
  redo(): boolean { return redo({ state: this.state, dispatch: (transaction) => this.dispatch(transaction) }); }

  private observe(event: DraftObservation): void {
    if (this.closed) return;
    if ("error" in event) this.synchronizationError = event.error;
    else if ("snapshot" in event && (event.snapshot.docId !== this.snapshot.docId || event.snapshot.revision !== this.snapshot.revision || event.snapshot.text !== this.snapshot.text)) {
      this.stale = true;
    } else if ("lease" in event && (event.lease?.token !== this.lease.token || event.lease.ownerWindow !== this.lease.ownerWindow)) {
      // During our own atomic Apply/Cancel, release precedes the command ack.
      if (!this.terminal) {
        // Events can arrive late; confirm against the authoritative lease before
        // invalidating local ownership. Never restore ownership from an event.
        void this.port.info(this.lease.docId).then((lease) => {
          if (!this.closed && !this.terminal && (lease?.token !== this.lease.token || lease.ownerWindow !== this.lease.ownerWindow)) {
            this.lostOwnership = true;
            this.synchronizationError = "Draft ownership changed. Copy this draft or Cancel; the other editor is preserved.";
          }
          this.emit();
        }).catch((error: unknown) => { this.synchronizationError = String(error); this.emit(); });
      }
    }
    this.emit();
  }

  private synchronize(text: string, generation: number, valid: boolean): Promise<void> {
    // A newer generation or explicit retry may repair a failed write. The
    // original failure remains exposed in error until a current write succeeds.
    const task = this.syncTail.catch(() => {}).then(async () => {
      if (this.closed || this.lostOwnership) return;
      const lease = await this.port.update(this.lease.docId, this.lease.token, { generation, text, valid });
      if (lease.generation >= this.lease.generation) this.lease = lease;
      if (!this.lostOwnership && generation === this.generation) this.synchronizationError = null;
    });
    this.syncTail = task;
    void task.catch((error: unknown) => {
      if (!this.closed && generation === this.generation) { this.synchronizationError = String(error); this.emit(); }
    });
    return task;
  }

  private revalidate(): void {
    const text = this.text;
    const generation = this.generation;
    this.validity = { valid: false, diagnostics: ["Validation pending"] };
    const pendingSync = this.synchronize(text, generation, false);
    this.validationTask = (async () => {
      try {
        await pendingSync;
        if (this.closed || generation !== this.generation || this.terminal) return;
        const result = await this.validate(text);
        if (this.closed || generation !== this.generation || this.terminal) return;
        this.validity = { valid: result.valid, diagnostics: [...result.diagnostics] };
        if (result.valid) this.lastValid = text;
        await this.synchronize(text, generation, result.valid);
      } catch (error) {
        if (this.closed || generation !== this.generation) return;
        this.validity = { valid: false, diagnostics: [String(error)] };
        this.synchronizationError = String(error);
      }
      if (!this.closed && generation === this.generation) this.emit();
    })();
  }

  async settle(): Promise<void> { await this.validationTask; await this.syncTail; }
  retryValidation(): void {
    if (this.closed || this.busy) throw new Error("draft is busy or closed");
    this.generation++;
    this.revalidate();
    this.emit();
  }

  async apply(): Promise<void> {
    if (!this.canApply) throw new Error("draft is invalid, stale, busy or unsynchronized; fix it, copy/reopen, or Cancel");
    this.applying = true;
    this.terminal = true;
    this.emit();
    try {
      await this.syncTail;
      const current = await this.port.snapshot(this.lease.docId);
      this.observe({ snapshot: current });
      const ops = prepareLocalizedEdit(current, {
        docId: this.snapshot.docId, baseRevision: this.snapshot.revision,
        authorizedRange: this.block.range, range: this.block.range,
        openingText: this.openingText, replacementText: this.text,
      });
      await this.port.apply({ ...this.lease, generation: this.generation }, ops);
      this.destroy();
    } catch (error) {
      this.terminal = false;
      this.synchronizationError = String(error);
      throw error;
    } finally { this.applying = false; this.emit(); }
  }

  async cancel(): Promise<void> {
    if (this.closed || this.busy) throw new Error("draft is busy or closed");
    if (this.lostOwnership) { this.destroy(); this.emit(); return; }
    this.applying = true;
    this.terminal = true;
    this.emit();
    try {
      // Cancellation need not validate text; drain prior writes so they cannot
      // arrive after release or target a later session.
      await this.syncTail.catch(() => {});
      await this.port.release(this.lease.docId, this.lease.token);
      this.destroy();
    } catch (error) { this.terminal = false; this.synchronizationError = String(error); throw error; }
    finally { this.applying = false; this.emit(); }
  }

  private destroy(): void {
    this.unwatch?.();
    this.unwatch = null;
    this.editor = null;
    this.generation++;
    this.lastValid = null;
    this.emit();
    this.listeners.clear();
  }
}
