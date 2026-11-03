import type { Change } from "./positions";

/** CodeMirror counts every line separator as one unit; canonical Markdown does not. */
export class SourceBuffer {
  readonly normalized: string;
  readonly lineEnding: string;
  private readonly crlfBoundaries: number[] = [];
  constructor(readonly text: string) {
    // Ordinary LF files need no coordinate table, including the 1 MiB input path.
    if (!text.includes("\r")) { this.normalized = text; this.lineEnding = "\n"; return; }
    this.normalized = text.replace(/\r\n|\r/g, "\n");
    this.lineEnding = /\r\n|\r|\n/.exec(text)?.[0] ?? "\n";
    let removed = 0;
    for (const match of text.matchAll(/\r\n/g)) {
      this.crlfBoundaries.push(match.index - removed + 1);
      removed++;
    }
  }
  rawOffset(offset: number): number {
    if (!Number.isInteger(offset) || offset < 0 || offset > this.normalized.length) throw new Error("invalid editor coordinate");
    let lo = 0, hi = this.crlfBoundaries.length;
    while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (this.crlfBoundaries[mid]! <= offset) lo = mid + 1; else hi = mid; }
    return offset + lo;
  }
  editorOffset(raw: number): number {
    const target = Math.max(0, Math.min(this.text.length, raw));
    let lo = 0, hi = this.normalized.length;
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (this.rawOffset(mid) <= target) lo = mid; else hi = mid - 1; }
    return lo;
  }
  changes(changes: readonly Change[]): { changes: Change[]; next: SourceBuffer } {
    const raw = changes.map((change) => ({ fromA: this.rawOffset(change.fromA), toA: this.rawOffset(change.toA), inserted: change.inserted.replace(/\r\n|\r|\n/g, this.lineEnding) }));
    let text = this.text;
    for (const change of [...raw].reverse()) text = text.slice(0, change.fromA) + change.inserted + text.slice(change.toA);
    return { changes: raw, next: new SourceBuffer(text) };
  }
}
