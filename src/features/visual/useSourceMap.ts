import { useEffect, useMemo, useState } from "react";
import { createSourceMap, type DocumentSourceMap, type SourceSnapshot } from "../../core/source-map";

function withinBudget(text: string): boolean {
  if (new TextEncoder().encode(text).length > 2 * 1024 * 1024) return false;
  const lines = text.split(/\r\n|\r|\n/);
  return lines.length <= 100_000 && !lines.some((line) => /^ {65}|^(?: *> *){33}/.test(line));
}

/** Discard obsolete workers; large parses must not run on the input thread. */
export function useSourceMap(snapshot: SourceSnapshot): { map: DocumentSourceMap | null; mapping: boolean; error: string | null } {
  const async = snapshot.text.length > 64 * 1024 && typeof Worker !== "undefined";
  const sync = useMemo(() => {
    if (async || !withinBudget(snapshot.text)) return null;
    try { return createSourceMap(snapshot, { maxDepth: 32, maxNodes: 200_000 }); }
    catch { return null; }
  }, [snapshot.docId, snapshot.revision, snapshot.text, async]);
  const [result, setResult] = useState<{ snapshot: SourceSnapshot; map: DocumentSourceMap | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!async || !withinBudget(snapshot.text)) return;
    let active = true;
    const worker = new Worker(new URL("./mapping-worker.ts", import.meta.url), { type: "module" });
    const finish = (map: DocumentSourceMap | null, error: string | null = null) => {
      if (active) setResult({ snapshot, map, error });
      worker.terminate(); clearTimeout(timeout);
    };
    const timeout = setTimeout(() => finish(null, "Source mapping exceeded its six-second deadline"), 6000);
    worker.onmessage = (event: MessageEvent<{ map?: DocumentSourceMap; error?: string }>) => finish(event.data.map ?? null, event.data.error ?? null);
    worker.onerror = (event) => finish(null, `Source mapping worker failed: ${event.message}`);
    worker.postMessage(snapshot);
    return () => { active = false; worker.terminate(); clearTimeout(timeout); };
  }, [snapshot.docId, snapshot.revision, snapshot.text, async]);
  const current = result?.snapshot.docId === snapshot.docId && result.snapshot.revision === snapshot.revision && result.snapshot.text === snapshot.text;
  return { map: async ? current ? result.map : null : sync, mapping: async && withinBudget(snapshot.text) && !current, error: current ? result.error : null };
}
