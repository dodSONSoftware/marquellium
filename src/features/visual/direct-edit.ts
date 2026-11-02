/** Bounded literal-text adapter. It never serializes an enclosing Markdown block. */
import { createSourceMap, type DocumentSourceMap, type MappedNode } from "../../core/source-map";
import { prepareLocalizedEdit, type LocalizedEdit } from "../../core/localized-edit";
import { ByteIndex, splitsPair } from "../../core/positions";
import { diffRange } from "../../core/text-diff";
import { applyOps, bytesToString, stringToBytes } from "../../core/ops";
import type { DocumentStore } from "../documents/DocumentStore";

const punctuation = /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/;
function decode(raw: string): { text: string; offsets: number[] } {
  let text = "";
  const offsets = [0];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "\\" && raw[i + 1] && punctuation.test(raw[i + 1]!)) i++;
    text += raw[i];
    offsets.push(i + 1);
  }
  return { text, offsets };
}
function pathTo(node: MappedNode, target: MappedNode): number[] | null {
  if (node === target) return [];
  for (let i = 0; i < node.children.length; i++) {
    const path = pathTo(node.children[i]!, target);
    if (path) return [i, ...path];
  }
  return null;
}
function shape(node: MappedNode): string { return `${node.type}(${node.children.map(shape).join(",")})`; }
function atPath(node: MappedNode, path: number[]): MappedNode | undefined {
  let current: MappedNode | undefined = node;
  for (const index of path) current = current?.children[index];
  return current;
}
export function editableText(leaf: MappedNode): boolean {
  return leaf.type === "text" && !!leaf.decodedText && !/[\r\n]/.test(leaf.source) && decode(leaf.source).text === leaf.decodedText;
}

export function directTextEdit(map: DocumentSourceMap, leaf: MappedNode, display: string) {
  const blockIndex = map.blocks.findIndex((block) => pathTo(block.node, leaf) !== null);
  const block = map.blocks[blockIndex];
  if (!block || !editableText(leaf) || !["text-candidate", "table-candidate"].includes(block.capability)) throw new Error("use the explicit source editor for this text");
  if (!display || /[\r\n]/.test(display) || display.length > 2048) throw new Error("direct text must be nonempty, single-line and at most 2048 characters; use source editing");
  const original = decode(leaf.source);
  const change = diffRange(original.text, display);
  let from = change.from, to = change.to, insertedEnd = change.from + change.insert.length;
  if (splitsPair(original.text, from) || splitsPair(display, from)) from--;
  if (splitsPair(original.text, to) || splitsPair(display, insertedEnd)) { to++; insertedEnd++; }
  const encoded = display.slice(from, insertedEnd).replace(/[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/g, "\\$&");
  const replacement = leaf.source.slice(0, original.offsets[from]) + encoded + leaf.source.slice(original.offsets[to]);
  const request: LocalizedEdit = { docId: map.snapshot.docId, baseRevision: map.snapshot.revision,
    authorizedRange: leaf.range, range: leaf.range, openingText: leaf.source, replacementText: replacement };
  const ops = prepareLocalizedEdit(map.snapshot, request);
  const applied = applyOps(stringToBytes(map.snapshot.text), ops);
  if (!applied.ok) throw new Error(applied.error);
  const expected = bytesToString(applied.next);
  const next = createSourceMap({ ...map.snapshot, revision: map.snapshot.revision + (ops.length ? 1 : 0), text: expected });
  const nextBlock = next.blocks[blockIndex];
  const path = pathTo(block.node, leaf)!;
  const nextLeaf = nextBlock && atPath(nextBlock.node, path);
  if (!nextLeaf || nextLeaf.decodedText !== display || nextLeaf.source !== replacement ||
      map.blocks.map((b) => shape(b.node)).join(";") !== next.blocks.map((b) => shape(b.node)).join(";")) {
    throw new Error("edit changes Markdown structure; use the explicit source editor");
  }
  // Check the byte conversion independently of a renderer/serializer.
  if (new ByteIndex(expected).byteOffset(nextLeaf.range.from) === null) throw new Error("unsafe resulting source range");
  return { request, next, nextLeaf, expected };
}

export class DirectTextController {
  private desired: string;
  private applied: string;
  private running: Promise<void> | null = null;
  private failure: string | null = null;
  private preparationRejected = false;
  private listeners = new Set<() => void>();
  constructor(private map: DocumentSourceMap, private leaf: MappedNode, private readonly store: Pick<DocumentStore, "applyLocalizedEdit" | "captureSourceSnapshot">) {
    this.desired = this.applied = leaf.decodedText ?? leaf.source;
  }
  get display(): string { return this.desired; }
  get revision(): number { return this.map.snapshot.revision; }
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
          edit = directTextEdit(this.map, this.leaf, display);
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
