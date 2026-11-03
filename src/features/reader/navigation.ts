import { restoreContext, type ViewContext } from "../../core/view-context";

function anchors(root: HTMLElement, length: number): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("[data-source-start]")].filter((node) => {
    const offset = Number(node.dataset.sourceStart);
    return Number.isInteger(offset) && offset >= 0 && offset <= length;
  });
}

/** Rendered selections have no exact source equivalent; use a safe block start. */
export function readerContext(root: HTMLElement, text: string): ViewContext | null {
  const top = root.getBoundingClientRect().top;
  const node = anchors(root, text.length).find((candidate) => candidate.getBoundingClientRect().bottom > top);
  if (!node) return null;
  const offset = Number(node.dataset.sourceStart);
  const safe = restoreContext({ text, anchor: offset, head: offset }, text);
  return { text, ...safe };
}

export function restoreReaderContext(root: HTMLElement, context: ViewContext, text: string): void {
  const { anchor } = restoreContext(context, text);
  const node = anchors(root, text.length).reduce<HTMLElement | null>((best, candidate) => {
    const offset = Number(candidate.dataset.sourceStart);
    return offset <= anchor && (!best || offset > Number(best.dataset.sourceStart)) ? candidate : best;
  }, null);
  node?.scrollIntoView?.({ block: "center" });
}

/** Source-block navigation used by split synchronization, independent of document height. */
export function scrollReaderOffset(root: HTMLElement, offset: number, length: number): void {
  const node = anchors(root, length).reduce<HTMLElement | null>((best, candidate) => {
    const start = Number(candidate.dataset.sourceStart);
    return start <= offset && (!best || start > Number(best.dataset.sourceStart)) ? candidate : best;
  }, null);
  if (node) {
    const bounds = root.getBoundingClientRect();
    const scale = root.offsetHeight ? bounds.height / root.offsetHeight || 1 : 1;
    root.scrollTop += (node.getBoundingClientRect().top - bounds.top) / scale;
  }
  else root.scrollTop = 0; // Frontmatter can precede the first rendered source anchor.
}
