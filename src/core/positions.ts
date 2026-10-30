/**
 * UTF-16 ↔ UTF-8 position mapping for the CodeMirror adapter (FR-051,
 * ADR-010).
 *
 * CodeMirror addresses its document in UTF-16 code units; the registry
 * addresses the canonical buffer in UTF-8 bytes (BOM-stripped). This module
 * keeps a cached code-unit→byte prefix table so op boundaries resolve in
 * O(1), maintained incrementally per local edit — a 1 MB document must
 * keep per-keystroke cost well inside the NFR-003 budget, so the table is
 * updated by a typed-array splice, not rebuilt from scratch, on the common
 * single-change path.
 *
 * Batch contract (mirrors the Rust registry, `apply_transaction`): every op
 * in one transaction addresses the PRE-batch buffer, in ascending
 * non-overlapping order. CodeMirror's `iterChanges` provides exactly that
 * shape via `fromA`/`toA` (positions in the document before the whole
 * change set), so the conversion is a direct map — no coordinate drift.
 *
 * Surrogate safety (FR-051): a code-unit index may sit BETWEEN the two
 * halves of a surrogate pair. Such a boundary maps to the middle of a
 * 4-byte UTF-8 sequence and the registry would (correctly) reject the op.
 * `byteOffset` returns null there so the adapter falls back to a
 * full-buffer replace instead of emitting an op the registry cannot apply.
 */

export class ByteIndex {
  /** table[i] = UTF-8 byte offset of code unit i; table has len+1 entries. */
  private table: Uint32Array;
  private text: string;

  constructor(text: string) {
    this.text = text;
    this.table = ByteIndex.buildTable(text);
  }

  static buildTable(text: string): Uint32Array {
    const n = text.length;
    const t = new Uint32Array(n + 1);
    let off = 0;
    for (let i = 0; i < n; i++) {
      t[i] = off;
      const c = text.charCodeAt(i);
      if (c >= 0xdc00 && c <= 0xdfff && i > 0 && isHigh(text.charCodeAt(i - 1))) {
        // Low unit of a pair: its 4 bytes were already counted at the
        // high unit, so this unit advances nothing.
        continue;
      }
      if (c < 0x80) off += 1;
      else if (c < 0x800) off += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < n && isLow(text.charCodeAt(i + 1))) {
        off += 4; // pair
      } else {
        off += 3;
      }
    }
    t[n] = off;
    return t;
  }

  /** Bounds-checked cell read (throws only on an internal invariant bug). */
  private static cell(t: Uint32Array, i: number): number {
    const v = t[i];
    if (v === undefined) throw new Error(`ByteIndex: cell ${i} out of range`);
    return v;
  }

  /** Byte length of the whole string this index was built from. */
  totalBytes(): number {
    return ByteIndex.cell(this.table, this.table.length - 1);
  }

  /**
   * Byte offset of code-unit index `i` (0..=len). Returns null when `i` is
   * out of range or falls between the halves of a surrogate pair: an op
   * boundary there would split a 4-byte UTF-8 sequence, which the registry
   * must (and does) reject.
   */
  byteOffset(i: number): number | null {
    const n = this.table.length - 1;
    if (i < 0 || i > n) return null;
    if (i > 0 && i < n && isHigh(this.text.charCodeAt(i - 1)) && isLow(this.text.charCodeAt(i))) {
      return null;
    }
    return ByteIndex.cell(this.table, i);
  }

  /**
   * Update the index after a CodeMirror change set. All changes are in
   * original-document (fromA/toA) coordinates; the single-change case is
   * the common one (typing, paste) and splices in O(n) memcpy, while a
   * multi-change set rebuilds (still O(n), rare: bulk command edits).
   */
  sync(newText: string, changes: Change[]): void {
    if (changes.length === 1) {
      const c = changes[0]!;
      const n = this.table.length - 1;
      if (c.fromA >= 0 && c.fromA <= c.toA && c.toA <= n) {
        this.text = newText;
        this.applySplice(c.fromA, c.toA, c.inserted);
        return;
      }
    }
    // Defensive: the index must match `newText` (the editor's document).
    this.text = newText;
    this.table = ByteIndex.buildTable(newText);
  }

  /** Single-change table splice (from/to in original coordinates). */
  private applySplice(from: number, to: number, inserted: string): void {
    const n = this.table.length - 1;
    const insertedTable = ByteIndex.buildTable(inserted);
    const insertedBytes = ByteIndex.cell(insertedTable, insertedTable.length - 1);
    const newLen = from + inserted.length + (n - to);
    const next = new Uint32Array(newLen + 1);
    const base = ByteIndex.cell(this.table, from);

    // Prefix: unchanged.
    next.set(this.table.subarray(0, from), 0);
    // Inserted region: shifted by `base` (positions from..from+insLen).
    for (let i = 0; i < insertedTable.length; i++) {
      next[from + i] = base + ByteIndex.cell(insertedTable, i);
    }
    // Suffix: old positions to..n move to from+insLen..newLen.
    const shift = base + insertedBytes - ByteIndex.cell(this.table, to);
    for (let i = to; i <= n; i++) {
      next[from + inserted.length + (i - to)] = ByteIndex.cell(this.table, i) + shift;
    }
    this.table = next;
  }
}

const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

/**
 * True when code-unit index `i` (0..len) splits a surrogate pair, i.e. `i`
 * is the position of a low surrogate whose high half precedes it.
 */
export function splitsPair(text: string, i: number): boolean {
  if (i <= 0 || i >= text.length) return false;
  return isHigh(text.charCodeAt(i - 1)) && isLow(text.charCodeAt(i));
}

/**
 * A CodeMirror change in original-document coordinates (`fromA`/`toA` from
 * `iterChanges`), code units.
 */
export interface Change {
  fromA: number;
  toA: number;
  inserted: string;
}

export interface ByteOp {
  startByte: number;
  endByte: number;
  text: string;
}

/**
 * Convert a CodeMirror change set to byte ops for the registry. The index
 * must describe the PRE-change document (all coordinates are A-space).
 * Returns null when any boundary is illegal (mid-surrogate-pair or out of
 * range) — the caller must fall back to a full-buffer replace op.
 */
export function changesToByteOps(
  index: ByteIndex,
  changes: Change[],
): ByteOp[] | null {
  const ops: ByteOp[] = [];
  for (const ch of changes) {
    const start = index.byteOffset(ch.fromA);
    const end = index.byteOffset(ch.toA);
    if (start === null || end === null || end < start) return null;
    ops.push({ startByte: start, endByte: end, text: ch.inserted });
  }
  return ops;
}
