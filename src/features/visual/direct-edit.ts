import type { DocumentSourceMap, MappedNode } from "../../core/source-map";
import type { DocumentStore } from "../documents/DocumentStore";
import { directTextEdit, displayedText } from "./direct-adapter";
export { directTextEdit, editableText } from "./direct-adapter";

function prepareDirectText(map: DocumentSourceMap, leaf: MappedNode, display: string): Promise<ReturnType<typeof directTextEdit>> {
  if (map.snapshot.text.length <= 64 * 1024 || typeof Worker === "undefined") return Promise.resolve(directTextEdit(map, leaf, display));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./direct-worker.ts", import.meta.url), { type: "module" });
    const timeout = setTimeout(() => { worker.terminate(); reject(new Error("direct edit validation timed out")); }, 6000);
    const finish = () => { clearTimeout(timeout); worker.terminate(); };
    worker.onerror = () => { finish(); reject(new Error("direct edit validator failed")); };
    worker.onmessage = (event: MessageEvent<{ edit?: ReturnType<typeof directTextEdit>; error?: string }>) => {
      finish();
      if (event.data.edit) resolve(event.data.edit); else reject(new Error(event.data.error ?? "direct edit validation failed"));
    };
    worker.postMessage({ snapshot: map.snapshot, from: leaf.range.from, to: leaf.range.to, display });
  });
}

export class DirectTextController {
  private desired: string;
  private applied: string;
  private running: Promise<void> | null = null;
  private failure: string | null = null;
  private preparationRejected = false;
  private listeners = new Set<() => void>();
  constructor(private map: DocumentSourceMap, private leaf: MappedNode, private readonly store: Pick<DocumentStore, "applyLocalizedEdit" | "captureSourceSnapshot">) {
    this.desired = this.applied = displayedText(leaf);
  }
  get display(): string { return this.desired; }
  get revision(): number { return this.map.snapshot.revision; }
  get sourceMap(): DocumentSourceMap { return this.map; }
  get hasPending(): boolean { return !!this.running || this.desired !== this.applied || !!this.failure; }
  get error(): string | null { return this.failure; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit() { for (const listener of this.listeners) listener(); }
  input(text: string): void {
    this.desired = text;
    if (this.failure && !this.preparationRejected) { this.emit(); return; }
    this.failure = null;
    this.preparationRejected = false;
    if (!this.running) {
      const work = this.drain();
      this.running = work;
      void work.finally(() => {
        this.running = null;
        if (!this.failure && this.desired !== this.applied) this.input(this.desired);
        else this.emit();
      });
    }
    this.emit();
  }
  async settle(): Promise<void> { await this.running; }
  private async drain(): Promise<void> {
    try {
      while (this.desired !== this.applied) {
        const display = this.desired;
        let edit: ReturnType<typeof directTextEdit>;
        try {
          edit = this.map.snapshot.text.length > 64 * 1024 && typeof Worker !== "undefined"
            ? await prepareDirectText(this.map, this.leaf, display)
            : directTextEdit(this.map, this.leaf, display);
        } catch (error) {
          // Empty text or trailing heading whitespace can be a transient typing
          // state. Nothing was dispatched, so later input may validate against
          // the same captured revision without retrying an uncertain commit.
          this.preparationRejected = true;
          this.failure = `${String(error)}. Text is retained locally. Continue editing to a supported value, or cancel pending text.`;
          return;
        }
        await this.store.applyLocalizedEdit(edit.request);
        const snapshot = await this.store.captureSourceSnapshot(this.map.snapshot.docId);
        if (snapshot.revision !== edit.next.snapshot.revision || snapshot.text !== edit.expected) throw new Error("document changed concurrently");
        this.map = edit.next;
        this.leaf = edit.nextLeaf;
        this.applied = display;
      }
    } catch (error) {
      this.preparationRejected = false;
      this.failure = `${String(error)}. Text is retained because the edit could not be confirmed; copy it or cancel pending text and check the current document.`;
    }
  }
}
