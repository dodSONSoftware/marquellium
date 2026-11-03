import { createSourceMap, type SourceSnapshot } from "../../core/source-map";
self.onmessage = (event: MessageEvent<SourceSnapshot>) => {
  try { self.postMessage({ map: createSourceMap(event.data, { maxDepth: 32, maxNodes: 200_000 }) }); }
  catch (error) { self.postMessage({ error: String(error) }); }
};
