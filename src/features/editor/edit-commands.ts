/**
 * Editing commands (FR-013): bold, italic, code, link, heading, list,
 * ordered list, quote, fence, task.
 *
 * Pure functions on (text, selection, command) → (newText, newSelection),
 * so they are unit-testable without a DOM. The CodeMirror wrapper
 * dispatches the result as a minimal diffed change (text-diff.ts), which
 * flows through the registry like any other edit (ADR-006/007).
 *
 * Conventions:
 *  - wrap commands (bold/italic/code) TOGGLE: wrapping text that is already
 *    wrapped with exactly the right markers unwraps it;
 *  - line commands (heading/list/quote/task) apply to every line spanned
 *    by the selection and toggle per line;
 *  - the returned selection is where the user's selection/caret should
 *    land next (VSCode-style).
 */
import { diffRange, mapPositions, type Range } from "../../core/text-diff";

/** New selection after a bulk text rewrite: map through the minimal diff. */
function remap(text: string, result: string, sel: Range): Range {
  return mapPositions(text.length, diffRange(text, result), sel.from, sel.to);
}

export type EditCommandId =
  | "bold"
  | "italic"
  | "code"
  | "link"
  | "heading"
  | "list"
  | "orderedList"
  | "quote"
  | "fence"
  | "task";

export interface EditResult {
  text: string;
  selection: Range;
}

// --- line helpers -----------------------------------------------------------

/** 1-based line bounds [start, end) for the line containing `pos`. */
function lineBounds(text: string, pos: number): Range {
  const start = text.lastIndexOf("\n", Math.min(pos, text.length) - 1) + 1;
  let end = text.indexOf("\n", start);
  if (end === -1) end = text.length;
  return { from: start, to: end };
}

/** All lines spanned by [from, to). */
function spannedLines(text: string, sel: Range): Range[] {
  if (text.length === 0) return [];
  const a = Math.min(sel.from, text.length);
  const b = Math.min(sel.to, text.length);
  const first = lineBounds(text, a);
  const last = lineBounds(text, b === a ? a : b - 1);
  // Walk from first.start to last.end collecting line starts.
  const lines: Range[] = [];
  let pos = first.from;
  while (pos <= last.to && pos <= text.length) {
    const lb = lineBounds(text, pos);
    if (lb.from >= last.to && lines.length > 0) break;
    lines.push(lb);
    if (lb.to >= text.length) break;
    pos = lb.to + 1;
  }
  return lines;
}

function prefixLine(line: Range, text: string, prefix: string): string {
  return text.slice(0, line.from) + prefix + text.slice(line.from, line.to);
}

function stripLinePrefix(line: Range, text: string, re: RegExp): string {
  const lineText = text.slice(line.from, line.to);
  const m = re.exec(lineText);
  if (m && m[0] !== undefined) {
    return text.slice(0, line.from) + lineText.slice(m[0].length) + text.slice(line.to);
  }
  return text;
}

// --- wrap toggle --------------------------------------------------------------

/**
 * Wrap [from,to) with `marker`; if the selection is immediately flanked by
 * the same markers (and nothing else selected between them), unwrap.
 */
function toggleWrap(
  text: string,
  sel: Range,
  marker: string,
): EditResult {
  const { from, to } = sel;
  const before = text.slice(Math.max(0, from - marker.length), from);
  const after = text.slice(to, to + marker.length);
  if (before === marker && after === marker) {
    // Unwrap.
    const newText =
      text.slice(0, from - marker.length) +
      text.slice(from, to) +
      text.slice(to + marker.length);
    return {
      text: newText,
      selection: { from: from - marker.length, to: to - marker.length },
    };
  }
  const inner = text.slice(from, to);
  const newText =
    text.slice(0, from) + marker + inner + marker + text.slice(to);
  return {
    text: newText,
    selection: { from: from + marker.length, to: to + marker.length },
  };
}

// --- commands ------------------------------------------------------------------

export function applyEditCommand(
  text: string,
  sel: Range,
  cmd: EditCommandId,
): EditResult | null {
  switch (cmd) {
    case "bold":
      return toggleWrap(text, sel, "**");
    case "italic":
      return toggleWrap(text, sel, "*");
    case "code": {
      // Inline code wraps a single line's selection; a multi-line
      // selection becomes a fenced block instead.
      const inner = text.slice(sel.from, sel.to);
      if (inner.includes("\n")) return fenceSelection(text, sel);
      return toggleWrap(text, sel, "`");
    }
    case "link": {
      const inner = text.slice(sel.from, sel.to);
      const newText =
        text.slice(0, sel.from) + `[${inner}](url)` + text.slice(sel.to);
      // Caret lands inside the parens, ready for the URL.
      const urlFrom = sel.from + 1 + inner.length + 2;
      return {
        text: newText,
        selection: { from: urlFrom, to: urlFrom },
      };
    }
    case "heading": {
      if (text.length === 0) return null;
      const line = lineBounds(text, Math.min(sel.from, text.length - 1));
      const lineText = text.slice(line.from, line.to);
      const m = /^(#{1,6})\s/.exec(lineText);
      if (m) {
        const level = (m[1] ?? "").length;
        if (level < 6) {
          // One more '#' at the line start (the existing run already
          // carries its space).
          const newText = text.slice(0, line.from) + "#" + text.slice(line.from);
          return { text: newText, selection: { from: sel.from + 1, to: sel.to + 1 } };
        }
        // Cycle off.
        const newText = text.slice(0, line.from) + lineText.replace(/^#{1,6}\s/, "") + text.slice(line.to);
        return { text: newText, selection: { from: Math.max(sel.from - 2, line.from), to: Math.max(sel.to - 2, line.from) } };
      }
      const newText = prefixLine(line, text, "## ");
      return {
        text: newText,
        selection: { from: sel.from + 3, to: sel.to + 3 },
      };
    }
    case "list":
      return toggleLinePrefix(text, sel, /^- (?!\[)/, "- ");
    case "orderedList":
      return orderedListCommand(text, sel);
    case "quote":
      return toggleLinePrefix(text, sel, /^> /, "> ");
    case "fence":
      return fenceSelection(text, sel);
    case "task":
      return taskCommand(text, sel);
  }
}

/** Toggle `prefix` on every spanned line (list/quote). */
function toggleLinePrefix(
  text: string,
  sel: Range,
  stripRe: RegExp,
  prefix: string,
): EditResult {
  const lines = spannedLines(text, sel);
  if (lines.length === 0) return { text, selection: sel };
  const allPrefixed = lines.every((l) => {
    const t = text.slice(l.from, l.to);
    return stripRe.test(t) || t.trim() === "";
  });
  let result = text;
  // Apply from the last line backward so earlier offsets stay valid.
  const ordered = [...lines].sort((a, b) => b.from - a.from);
  for (const line of ordered) {
    if (allPrefixed) {
      result = stripLinePrefix(line, result, stripRe);
    } else {
      const lineText = result.slice(line.from, line.to);
      if (lineText.trim() !== "" && !stripRe.test(lineText)) {
        result = result.slice(0, line.from) + prefix + result.slice(line.from);
      }
    }
  }
  return { text: result, selection: remap(text, result, sel) };
}

function orderedListCommand(text: string, sel: Range): EditResult {
  const lines = spannedLines(text, sel);
  if (lines.length === 0) return { text, selection: sel };
  const allNumbered = lines.every((l) => /^\d+\. /.test(text.slice(l.from, l.to)) || text.slice(l.from, l.to).trim() === "");
  let result = text;
  if (allNumbered) {
    const ordered = [...lines].sort((a, b) => b.from - a.from);
    for (const line of ordered) result = stripLinePrefix(line, result, /^\d+\. /);
  } else {
    // Number forward, apply backward: offsets stay valid.
    const numbered: { line: Range; num: number }[] = [];
    let n = 1;
    for (const line of lines) {
      const lineText = text.slice(line.from, line.to);
      if (lineText.trim() !== "" && !/^\d+\. /.test(lineText)) {
        numbered.push({ line, num: n });
        n++;
      }
    }
    for (const { line, num } of [...numbered].sort((a, b) => b.line.from - a.line.from)) {
      result = result.slice(0, line.from) + `${num}. ` + result.slice(line.from);
    }
  }
  return { text: result, selection: remap(text, result, sel) };
}

function taskCommand(text: string, sel: Range): EditResult {
  const lines = spannedLines(text, sel);
  if (lines.length === 0) return { text, selection: sel };
  let result = text;
  const ordered = [...lines].sort((a, b) => b.from - a.from);
  for (const line of ordered) {
    const lineText = result.slice(line.from, line.to);
    if (/^- \[x\] /.test(lineText)) {
      // checked → plain (drop the whole marker)
      result = result.slice(0, line.from) + result.slice(line.from + 6);
    } else if (/^- \[ \] /.test(lineText)) {
      // unchecked → checked
      result = result.slice(0, line.from) + "- [x] " + result.slice(line.from + 6);
    } else if (/^- (?!\[)/.test(lineText)) {
      // plain list item → unchecked task
      result = result.slice(0, line.from) + "- [ ] " + result.slice(line.from + 2);
    } else if (lineText.trim() !== "") {
      result = result.slice(0, line.from) + "- [ ] " + result.slice(line.from);
    }
  }
  return { text: result, selection: remap(text, result, sel) };
}

function fenceSelection(text: string, sel: Range): EditResult {
  let inner = text.slice(sel.from, sel.to);
  let from = sel.from;
  let to = sel.to;
  if (inner === "" && text.length > 0) {
    const line = lineBounds(text, Math.min(sel.from, text.length - 1));
    inner = text.slice(line.from, line.to);
    from = line.from;
    to = line.to;
  }
  const newText =
    text.slice(0, from) + "```\n" + inner + "\n```" + text.slice(to);
  return {
    text: newText,
    selection: { from: from + 4, to: from + 4 + inner.length },
  };
}
