import { createSourceMap, type MappedNode, type SourceSnapshot } from "../../core/source-map";
import { directTextEdit } from "./direct-adapter";
self.onmessage = (event: MessageEvent<{ snapshot: SourceSnapshot; from: number; to: number; display: string }>) => {
  try {
    const { snapshot, from, to, display } = event.data;
    const map = createSourceMap(snapshot, { maxDepth: 32, maxNodes: 200_000 });
    const find = (node: MappedNode): MappedNode | undefined => (node.type === "text" || node.type === "tableCell") && node.range.from === from && node.range.to === to ? node : node.children.map(find).find(Boolean);
    const leaf = map.blocks.map((block) => find(block.node)).find(Boolean);
    if (!leaf) throw new Error("direct edit source identity changed");
    self.postMessage({ edit: directTextEdit(map, leaf, display) });
  } catch (error) { self.postMessage({ error: String(error) }); }
};
