/**
 * Text-level prefix/suffix diff for the editor adapter.
 *
 * When the shell computes a new document text (editing command, external
 * replace) it must dispatch the SMALLEST CodeMirror change — a full-document
 * replace would emit a full-buffer op instead of a minimal one (ADR-007)
 * and would obliterate the user's selection. A longest-common-prefix/suffix
 * diff gives the minimal single change for the transformations this app
 * performs (localized edits, whole-doc external replaces).
 */

export interface Range {
  from: number;
  to: number;
}

export interface SingleChange extends Range {
  insert: string;
}

/**
 * Minimal single change transforming `oldText` into `newText`
 * (code units). The change is [from, to) in oldText, replaced by `insert`.
 */
export function diffRange(oldText: string, newText: string): SingleChange {
  const n = oldText.length;
  const m = newText.length;
  if (oldText === newText) return { from: 0, to: 0, insert: "" };
  const min = Math.min(n, m);
  let p = 0;
  while (p < min && oldText.charCodeAt(p) === newText.charCodeAt(p)) p++;
  let s = 0;
  while (
    s < min - p &&
    oldText.charCodeAt(n - 1 - s) === newText.charCodeAt(m - 1 - s)
  ) {
    s++;
  }
  return { from: p, to: n - s, insert: newText.slice(p, m - s) };
}

/**
 * Map an old-document selection through `diffRange`'s change. Positions
 * inside the changed region collapse to its start; positions after it are
 * shifted by the net length delta. The result is clamped to the new doc.
 */
export function mapPositions(
  oldLen: number,
  change: SingleChange,
  from: number,
  to: number,
): Range {
  const newLen = change.from + change.insert.length + (oldLen - change.to);
  const map = (i: number): number => {
    if (i <= change.from) return i;
    if (i >= change.to) return i + (change.insert.length - (change.to - change.from));
    return change.from;
  };
  let a = map(from);
  let b = map(to);
  if (a < 0) a = 0;
  if (b < 0) b = 0;
  if (a > newLen) a = newLen;
  if (b > newLen) b = newLen;
  if (a > b) [a, b] = [b, a];
  return { from: a, to: b };
}
