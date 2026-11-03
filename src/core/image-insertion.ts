import { restoreContext, type ViewContext } from "./view-context";
import { createSourceMap, type MappedNode, type SourceSnapshot, type Utf16Offset } from "./source-map";
import type { LocalizedEdit } from "./localized-edit";

/** Inline in text/cells; otherwise insert after the construct, preserving its syntax. */
export function imageInsertion(snapshot: SourceSnapshot, context: ViewContext | undefined, path: string): LocalizedEdit {
  if (!/^[A-Za-z0-9_.~%\/-]+$/.test(path) || path.split("/").some((part) => part === ".." || part === ".") || path.startsWith("/")) throw new Error("Unsafe generated image path");
  const position = context ? restoreContext(context, snapshot.text) : { anchor: snapshot.text.length, head: snapshot.text.length };
  let from = Math.min(position.anchor, position.head), to = Math.max(position.anchor, position.head);
  const map = createSourceMap(snapshot, { maxDepth: 32, maxNodes: 200_000 });
  const block = map.blocks.find((block) => block.range.from <= from && block.range.to >= to);
  const editable = (node: MappedNode): boolean => {
    if (node.type === "text" && node.range.from <= from && node.range.to >= to) return true;
    if (node.type === "tableCell" && !node.children.length) {
      const start = node.range.from + (/^\|?[ \t]*/.exec(node.source)?.[0].length ?? 0);
      return from === to && from === start;
    }
    return node.children.some(editable);
  };
  const inline = block && editable(block.node);
  const ending = snapshot.text.match(/\r\n|\r|\n/)?.[0] ?? "\n";
  if (!inline && block) from = to = block.range.to;
  const range = { docId: snapshot.docId, revision: snapshot.revision, from: from as Utf16Offset, to: to as Utf16Offset };
  const image = `![Pasted image](${path})`;
  return { docId: snapshot.docId, baseRevision: snapshot.revision, authorizedRange: range, range, openingText: snapshot.text.slice(from, to), replacementText: inline ? image : `${ending}${ending}${image}${ending}${ending}` };
}
