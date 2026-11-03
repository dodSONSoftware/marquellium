import { diffRange, mapPositions } from "./text-diff";
import { splitsPair } from "./positions";

/** Source coordinates are the common navigation language of every view. */
export interface ViewContext { text: string; anchor: number; head: number }

export function restoreContext(context: ViewContext, text: string): { anchor: number; head: number } {
  const change = diffRange(context.text, text);
  const mapped = mapPositions(context.text.length, change, context.anchor, context.head);
  const safe = (value: number) => {
    const offset = Math.max(0, Math.min(text.length, value));
    let target = splitsPair(text, offset) ? offset - 1 : offset;
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    target = segmenter.segment(text).containing(target)?.index ?? target;
    return target;
  };
  return context.anchor <= context.head
    ? { anchor: safe(mapped.from), head: safe(mapped.to) }
    : { anchor: safe(mapped.to), head: safe(mapped.from) };
}
