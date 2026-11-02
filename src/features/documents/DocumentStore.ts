/**
 * Per-window document mirror (ADR-006).
 *
 * The Rust registry is canonical; this store keeps the local view's
 * byte-faithful mirror, applies broadcast transactions, and issues edits
 * as revision-checked transactions. The local op queue is serialized: op N+1
 * is dispatched only after op N's ack, so a fast typist can never race the
 * registry.
 *
 * **No optimistic mirror updates.** The editor's view is the user's truth;
 * the mirror moves only when the registry's broadcast/ack confirms a
 * transaction. (An optimistic mirror plus the broadcast re-applying the
 * same ops double-applies them — benign for a full-buffer replace, which
 * re-validates as invalid, but corrupting for a minimal-op chain like
 * `insert@0, insert@1, …`, which re-applies cleanly onto the already-edited
 * buffer and duplicates the text.)
 *
 * Edit groups: `editGroup` accumulates a keystroke burst's minimal ops and
 * commits them as ONE registry transaction per group (undo granularity =
 * edit group, FR-040/ADR-007). `flushGroup` commits immediately and MUST
 * be awaited before save/undo/redo/reload/dispose so nothing is lost.
 */
import {
  native,
  onDraftChanged,
  type DocumentSnapshot,
  type DocumentUpdate,
  type SaveResult,
} from "../../services/native";
import {
  applyOps,
  bytesToString,
  fullReplaceOp,
  stringToBytes,
  type ByteOp,
} from "../../core/ops";
import { ByteIndex, changesToByteOps } from "../../core/positions";
import { diffRange } from "../../core/text-diff";
import { captureLocalizedEdit, prepareLocalizedEdit, type LocalizedEdit } from "../../core/localized-edit";
import type { DraftLease, DraftPort } from "../../core/draft-session";
import { subscriptionScope } from "../../services/subscription-scope";
import type { SourceSnapshot } from "../../core/source-map";

interface QueuedBatch {
  prepare: (doc: LocalDoc) => { baseRevision: number; ops: ByteOp[]; localized?: boolean; commit?: () => Promise<DocumentUpdate | null> };
  resolve: () => void;
  reject: (err: unknown) => void;
}

export interface LocalDoc {
  docId: string;
  path: string | null;
  bytes: Uint8Array;
  revision: number;
  dirty: boolean;
  bom: boolean;
  newline: DocumentSnapshot["newline"];
  savedContentHash: string | null;
}

export type StoreListener = (docs: Map<string, LocalDoc>) => void;

interface EditGroup {
  /** Per-keystroke ops: drive `projected`; never sent to the registry. */
  ops: ByteOp[];
  /** Group-start mirror bytes — the base the committed diff is computed
   *  against (the registry's pre-batch buffer). */
  start: Uint8Array;
  /** Mirror bytes with the group's ops projected on (= the view's text). */
  projected: Uint8Array;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * The registry transaction that commits a group: a single minimal op
 * expressing the group's NET change, computed against the group-start
 * buffer.
 *
 * Why not send the accumulated per-keystroke ops? The registry contract
 * (`apply_transaction`) addresses EVERY op in a transaction to the
 * PRE-batch buffer, ascending, applied in reverse. Per-keystroke ops do
 * not satisfy that: each keystroke's change is addressed to the document
 * AFTER the previous keystroke (CodeMirror's A-space is per-update).
 * Sending them raw would make the registry apply later ops at stale
 * offsets — scattered characters, phantom newlines — and record a wrong
 * `old_text`, corrupting undo. The net diff (group start → final) is in
 * group-start coordinates by construction and coalesces the burst into
 * one ascending op (ADR-007's undo granularity is per GROUP, so this
 * loses no undo semantics).
 */
function groupDiffOps(start: Uint8Array, final: Uint8Array): ByteOp[] {
  const startText = bytesToString(start);
  const finalText = bytesToString(final);
  if (startText === finalText) return [];
  const change = diffRange(startText, finalText);
  if (change.from === change.to && change.insert === "") return [];
  const ops = changesToByteOps(new ByteIndex(startText), [
    { fromA: change.from, toA: change.to, inserted: change.insert },
  ]);
  if (ops === null) {
    // diffRange boundaries sit at character boundaries, so a surrogate
    // split here is practically unreachable; fail safe with a full
    // replace against the group-start buffer.
    return [fullReplaceOp(start, finalText)];
  }
  return ops;
}

export class DocumentStore {
  private docs = new Map<string, LocalDoc>();
  private pendingQueue = new Map<string, QueuedBatch[]>();
  private processing = new Set<string>();
  private queueTails = new Map<string, Promise<void>>();
  private localizedTails = new Map<string, Promise<void>>();
  private commits = new Map<string, Promise<void>>();
  private commitErrors = new Map<string, unknown>();
  private committingBytes = new Map<string, Uint8Array>();
  private pendingGroups = new Map<string, EditGroup>();
  private recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private listeners = new Set<StoreListener>();

  /**
   * Keystroke-burst window: ops arriving within this span of the last one
   * join the same registry transaction, so undo granularity is an edit
   * group, not a keystroke (ADR-007). 100 ms is comfortably below
   * human pause detection and above per-keystroke IPC latency.
   */
  private static readonly GROUP_WINDOW_MS = 100;

  subscribe(fn: StoreListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn(this.docs);
  }

  get(docId: string): LocalDoc | undefined {
    return this.docs.get(docId);
  }

  get list(): LocalDoc[] {
    return [...this.docs.values()];
  }

  content(docId: string): string {
    const d = this.docs.get(docId);
    return d ? bytesToString(d.bytes) : "";
  }

  async newDocument(): Promise<string> {
    const docId = await native.documents.new();
    await this.adopt(docId);
    return docId;
  }

  async openDocument(path: string, convertLatin1 = false): Promise<string> {
    const snap = await native.documents.open(path, convertLatin1);
    if (this.docs.has(snap.docId)) {
      // Already mirrored in this window (same tab re-opened, or the same
      // file opened from two windows that share this mirror): do not take
      // another view or clobber local state.
      return snap.docId;
    }
    await this.adopt(snap.docId);
    return snap.docId;
  }

  async attachDocument(docId: string): Promise<void> {
    if (!this.docs.has(docId)) await this.adopt(docId);
  }

  private async adopt(docId: string): Promise<void> {
    const snap = await native.documents.snapshot(docId);
    if (!snap) throw new Error(`unknown document ${docId}`);
    await native.documents.acquire(docId);
    this.docs.set(docId, this.fromSnapshot(snap));
    this.emit();
  }

  private fromSnapshot(snap: DocumentSnapshot): LocalDoc {
    return {
      docId: snap.docId,
      path: snap.path,
      bytes: stringToBytes(snap.content),
      revision: snap.revision,
      dirty: snap.dirty,
      bom: snap.bom,
      newline: snap.newline,
      savedContentHash: snap.savedContentHash,
    };
  }

  /** Apply a broadcast transaction to the local mirror (byte-exact). */
  applyUpdate(update: DocumentUpdate): void {
    const doc = this.docs.get(update.docId);
    if (!doc) return; // not open in this window
    if (update.revision <= doc.revision) return;
    if (update.revision !== doc.revision + 1) {
      void this.resync(update.docId);
      return;
    }
    const res = applyOps(doc.bytes, update.ops);
    if (!res.ok) {
      // A stale/invalid broadcast must never corrupt the mirror; refetch.
      void this.resync(update.docId);
      return;
    }
    doc.bytes = res.next;
    doc.revision = update.revision;
    doc.dirty = update.dirty;
    this.emit();
  }

  private async resync(docId: string): Promise<void> {
    const snap = await native.documents.snapshot(docId);
    const current = this.docs.get(docId);
    if (snap && current && snap.revision >= current.revision) {
      this.docs.set(docId, this.fromSnapshot(snap));
      this.emit();
    }
  }

  /** A save changes metadata without advancing the canonical text revision. */
  async refreshSavedDocument(docId: string): Promise<void> {
    if (!this.docs.has(docId)) return;
    await this.resync(docId);
    if (!this.isDirty(docId)) this.clearRecovery(docId);
  }

  // --- edit groups (M3, ADR-006/007) ----------------------------------------

  /**
   * True when the document has unsaved content: committed-dirty in the
   * registry, OR a keystroke group not yet committed (the user typed and
   * the group window hasn't elapsed — the close prompt must see it).
   */
  isDirty(docId: string): boolean {
    const d = this.docs.get(docId);
    if (!d) return false;
    return d.dirty || this.commitErrors.has(docId) || this.hasPendingTransactions(docId);
  }

  private hasPendingTransactions(docId: string): boolean {
    return this.localizedTails.has(docId) || this.queueTails.has(docId) ||
      this.commits.has(docId) || (this.pendingGroups.get(docId)?.ops.length ?? 0) > 0;
  }

  /**
   * The text the editor is AHEAD of the mirror by (in-flight group):
   * mirror bytes with the pending group's ops applied, or null when no
   * group is in flight. The editor's reconciliation uses this to tell
   * "the view is ahead, the mirror will catch up" apart from a real
   * external change — without it, a broadcast of a just-committed group
   * arriving while the next group is typing would be misread as an
   * outside edit and rewrite the user's own keystrokes.
   */
  projectedText(docId: string): string | null {
    const g = this.pendingGroups.get(docId);
    if (!g || g.ops.length === 0) {
      const bytes = this.committingBytes.get(docId);
      return bytes ? bytesToString(bytes) : null;
    }
    return bytesToString(g.projected);
  }

  /**
   * Commit a whole-buffer edit as a single transaction. Used by the
   * recovery-restore path; the editor uses `editGroup` for minimal ops.
   */
  async editFullContent(docId: string, text: string): Promise<void> {
    await this.flushGroup(docId);
    const doc = this.docs.get(docId);
    if (!doc) throw new Error(`unknown document ${docId}`);
    const op = fullReplaceOp(doc.bytes, text);
    this.scheduleRecovery(docId);
    await this.enqueue(docId, [op]);
  }

  /** Capture mapping input only after all earlier local transactions acknowledge. */
  async captureSourceSnapshot(docId: string): Promise<SourceSnapshot> {
    do {
      await this.flushGroup(docId);
    } while (this.hasPendingTransactions(docId));
    const doc = this.docs.get(docId);
    if (!doc) throw new Error(`unknown document ${docId}`);
    return Object.freeze({ docId, revision: doc.revision, text: bytesToString(doc.bytes) });
  }

  /** Submit a captured range edit once; never rebase it onto a newer revision. */
  applyLocalizedEdit(edit: LocalizedEdit): Promise<void> {
    const captured = captureLocalizedEdit(edit);
    return this.serializeLocalized(captured.docId, async () => {
      let changed = false;
      await this.enqueuePrepared(captured.docId, (doc) => {
        if (this.pendingGroups.has(captured.docId)) throw new Error("pending Source edits; capture a fresh snapshot");
        const current = { docId: doc.docId, revision: doc.revision, text: bytesToString(doc.bytes) };
        const ops = prepareLocalizedEdit(current, captured);
        changed = ops.length > 0;
        return { baseRevision: captured.baseRevision, ops, localized: true };
      });
      if (changed && this.docs.has(captured.docId)) this.scheduleRecovery(captured.docId);
    });
  }

  private serializeLocalized(docId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.localizedTails.get(docId);
    const done = (async () => {
      await previous;
      await this.flushCanonicalQueue(docId);
      await operation();
    })();
    // Register before returning, including the pre-dispatch Source flush. A
    // Save/close immediately after Apply must see the entire pending operation.
    this.localizedTails.set(docId, done);
    const clearTail = () => {
      if (this.localizedTails.get(docId) === done) this.localizedTails.delete(docId);
    };
    void done.then(clearTail, clearTail);
    return done;
  }

  /** Draft commands share the canonical queue, but CM draft history never does. */
  get draftPort(): DraftPort {
    return {
      snapshot: async (docId) => {
        await this.flushGroup(docId);
        await this.resync(docId);
        return this.captureSourceSnapshot(docId);
      },
      info: native.drafts.info,
      acquire: native.drafts.acquire,
      update: native.drafts.update,
      release: native.drafts.release,
      apply: (lease, ops) => this.commitDraft(lease, ops),
      watch: (docId, listener) => {
        const subscriptions = subscriptionScope((error) => listener({ error: String(error) }));
        subscriptions.add(onDraftChanged((event) => { if (event.docId === docId) listener({ lease: event.lease }); }));
        const unsubscribe = this.subscribe((docs) => {
          const doc = docs.get(docId);
          if (doc) listener({ snapshot: { docId, revision: doc.revision, text: bytesToString(doc.bytes) } });
        });
        return () => { subscriptions.dispose(); unsubscribe(); };
      },
    };
  }

  private commitDraft(lease: DraftLease, ops: ByteOp[]): Promise<void> {
    lease = { ...lease, opening: { ...lease.opening } };
    ops = ops.map((op) => ({ ...op }));
    return this.serializeLocalized(lease.docId, async () => {
      await this.enqueuePrepared(lease.docId, (doc) => {
        if (this.pendingGroups.has(lease.docId)) throw new Error("pending Source edits; draft Apply must retry against current state");
        if (doc.revision !== lease.opening.baseRevision) throw new Error("stale draft revision");
        return { baseRevision: lease.opening.baseRevision, ops,
          commit: () => native.drafts.apply(lease.docId, lease.token, lease.generation, ops) };
      });
      if (ops.length > 0 && this.docs.has(lease.docId)) this.scheduleRecovery(lease.docId);
    });
  }

  /**
   * Editor entry (CodeMirror adapter): accumulate this change set's
   * minimal ops into the active group. The group commits as ONE registry
   * transaction (one undo step) carrying the group's NET diff — see
   * `groupDiffOps` for why the per-keystroke ops themselves are never
   * sent (registry ops address the pre-batch buffer; keystroke ops are
   * addressed to the post-previous-keystroke document). Ops must validate
   * against the group's projected bytes; otherwise the group is dropped
   * and the mirror is resynced from the registry — the editor reloads
   * from the next mirror update (fail closed, the registry is never
   * forced).
   */
  editGroup(docId: string, ops: ByteOp[]): void {
    const doc = this.docs.get(docId);
    if (!doc) return;
    let g = this.pendingGroups.get(docId);
    if (!g) {
      g = {
        ops: [],
        start: (this.committingBytes.get(docId) ?? doc.bytes).slice(),
        projected: (this.committingBytes.get(docId) ?? doc.bytes).slice(),
        timer: null,
      };
      this.pendingGroups.set(docId, g);
    }
    const res = applyOps(g.projected, ops);
    if (!res.ok) {
      this.abortGroup(docId);
      void this.resync(docId);
      return;
    }
    g.ops.push(...ops);
    g.projected = res.next;
    if (g.timer) clearTimeout(g.timer);
    g.timer = setTimeout(
      () => void this.commitGroup(docId).catch(() => {}),
      DocumentStore.GROUP_WINDOW_MS,
    );
  }

  /** Drop a pending group without committing (invalid op, or dispose). */
  private abortGroup(docId: string): void {
    const g = this.pendingGroups.get(docId);
    if (!g) return;
    if (g.timer) clearTimeout(g.timer);
    this.pendingGroups.delete(docId);
  }

  /** Flush all local groups and queued transactions (pagehide is best-effort). */
  flushAll(): Promise<void[]> {
    const ids = new Set([...this.pendingGroups.keys(), ...this.commits.keys(), ...this.queueTails.keys(), ...this.localizedTails.keys()]);
    return Promise.all([...ids].map((id) => this.flushGroup(id)));
  }

  /**
   * Awaitable immediate commit of the pending group; resolves when the
   * registry acks (or immediately when nothing is pending). MUST be
   * awaited before save/undo/redo/reload/dispose.
   */
  async flushGroup(docId: string): Promise<void> {
    do {
      await this.localizedTails.get(docId);
      await this.flushCanonicalQueue(docId);
    } while (this.hasPendingTransactions(docId));
  }

  private async flushCanonicalQueue(docId: string): Promise<void> {
    do {
      await this.commits.get(docId);
      await this.commitGroup(docId);
      await this.queueTails.get(docId);
      if (this.commitErrors.has(docId)) throw this.commitErrors.get(docId);
    } while (this.pendingGroups.has(docId) || this.commits.has(docId) || this.queueTails.has(docId));
  }

  private async commitGroup(docId: string): Promise<void> {
    const g = this.pendingGroups.get(docId);
    if (!g) return;
    if (g.timer) {
      clearTimeout(g.timer);
      g.timer = null;
    }
    if (g.ops.length === 0) {
      this.pendingGroups.delete(docId);
      return;
    }
    this.pendingGroups.delete(docId);
    const ops = groupDiffOps(g.start, g.projected);
    if (ops.length === 0) return; // burst netted to zero (e.g. type+delete)
    this.scheduleRecovery(docId);
    this.committingBytes.set(docId, g.projected);
    const commit = this.enqueue(docId, ops);
    this.commits.set(docId, commit);
    try {
      await commit;
    } catch (err) {
      this.commitErrors.set(docId, err);
      throw err;
    } finally {
      if (this.commits.get(docId) === commit) {
        this.commits.delete(docId);
        this.committingBytes.delete(docId);
      }
    }
  }

  /**
   * Enqueue ops for a document, serialized behind any in-flight batch.
   * Resolves when the registry acks THIS batch. The mirror's BYTES move
   * via the first broadcast or acknowledgement for a revision; duplicate
   * deliveries are ignored so delayed events cannot replay an edit.
   */
  private enqueue(docId: string, ops: ByteOp[]): Promise<void> {
    return this.enqueuePrepared(docId, (doc) => ({ baseRevision: doc.revision, ops }));
  }

  private enqueuePrepared(docId: string, prepare: QueuedBatch["prepare"]): Promise<void> {
    const q = this.pendingQueue.get(docId) ?? [];
    let resolve!: () => void;
    let reject!: (err: unknown) => void;
    const done = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    q.push({ prepare, resolve, reject });
    this.queueTails.set(docId, done);
    const clearTail = () => {
      if (this.queueTails.get(docId) === done) this.queueTails.delete(docId);
    };
    void done.then(clearTail, clearTail);
    this.pendingQueue.set(docId, q);
    if (this.processing.has(docId)) return done;
    this.processing.add(docId);
    (async () => {
      try {
        for (;;) {
          const item = this.pendingQueue.get(docId)?.shift();
          if (!item) break;
          const doc = this.docs.get(docId);
          if (!doc) {
            item.reject(new Error(`unknown document ${docId}`));
            continue;
          }
          try {
            const { baseRevision, ops, localized, commit } = item.prepare(doc);
            if (ops.length === 0 && !commit) {
              item.resolve();
              continue;
            }
            const update = commit ? await commit() : localized
              ? await native.documents.applyLocalized(docId, baseRevision, ops)
              : await native.documents.apply(docId, baseRevision, ops);
            // A resync may have replaced the mirror object while IPC was in
            // flight. Reconcile by document ID/revision, not object identity.
            if (update) this.applyUpdate(update);
            item.resolve();
          } catch (err) {
            const msg = String(err);
            if (
              msg.includes("stale revision") ||
              msg.includes("char boundary") ||
              msg.includes("exceeds")
            ) {
              // Another window moved the buffer, or an invalid op reached
              // the registry: the registry is the arbiter. The resync
              // moves the mirror to its truth; surviving batches re-
              // validate against the new revision or reject safely.
              try {
                await this.resync(docId);
              } catch (syncError) {
                item.reject(new AggregateError([err, syncError], "transaction rejected and resync failed"));
                continue;
              }
            }
            item.reject(err);
          }
        }
      } finally {
        this.processing.delete(docId);
        this.emit();
      }
    })();
    return done;
  }

  async undo(docId: string): Promise<void> {
    // The pending group must be a committed transaction first, or the undo
    // would pop the user's in-flight keystrokes instead of the last step
    // (AT-103: shared history, single source).
    await this.flushGroup(docId);
    await native.documents.undo(docId);
    // The broadcast updates the mirror; await a resync as fallback.
    await this.resync(docId);
  }

  async redo(docId: string): Promise<void> {
    await this.flushGroup(docId);
    await native.documents.redo(docId);
    await this.resync(docId);
  }

  async save(docId: string): Promise<SaveResult> {
    // Persist exactly what the user sees: commit the in-flight group.
    try {
      await this.flushGroup(docId);
    } catch (err) {
      return { ok: false, reason: "io-error", message: String(err), revision: null };
    }
    const res = await native.documents.save(docId);
    await this.resync(docId);
    if (res.ok) this.clearRecovery(docId);
    return res;
  }

  async saveAs(docId: string, path: string): Promise<SaveResult> {
    try {
      await this.flushGroup(docId);
    } catch (err) {
      return { ok: false, reason: "io-error", message: String(err), revision: null };
    }
    const res = await native.documents.saveAs(docId, path);
    await this.resync(docId);
    if (res.ok) this.clearRecovery(docId);
    return res;
  }

  /** Replace the mirror with current disk content (confirmed reload). */
  async reloadFromDisk(docId: string): Promise<void> {
    // A reload discards local uncommitted edits by definition; abort the
    // group rather than committing it and then throwing it away.
    this.abortGroup(docId);
    await native.documents.reload(docId);
    await this.resync(docId);
  }

  /** Drop a document from the mirror after close resolution. Idempotent: a
   * double release (e.g. StrictMode double effect, or a tab closed while
   * another window holds the only remaining view elsewhere) must not throw.
   * A pending group is ABORTED, not committed: anything the user chose to
   * keep already went through save (which flushes), and committing here
   * would resurrect "discarded" edits into the recovery store. */
  async dispose(docId: string): Promise<void> {
    this.abortGroup(docId);
    this.clearRecovery(docId);
    if (this.docs.delete(docId)) {
      this.pendingQueue.delete(docId);
      // Release is best-effort: the registry is the canonical owner and
      // surviving a double release is required (AT-117).
      await native.documents.release(docId).catch(() => {});
      await native.documents.dispose(docId).catch(() => {});
    }
    this.emit();
  }

  async release(docId: string): Promise<void> {
    await native.documents.release(docId);
  }

  /** Debounced recovery snapshot (FR-006). Draft = null in M1. */
  private scheduleRecovery(docId: string): void {
    this.clearRecovery(docId);
    this.recoveryTimers.set(
      docId,
      setTimeout(() => {
        this.recoveryTimers.delete(docId);
        void native.documents.recoverySnapshot(docId, null).catch(() => {});
      }, 2000),
    );
  }

  private clearRecovery(docId: string): void {
    const t = this.recoveryTimers.get(docId);
    if (t) {
      clearTimeout(t);
      this.recoveryTimers.delete(docId);
    }
  }
}
