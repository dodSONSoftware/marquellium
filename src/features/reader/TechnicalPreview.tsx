import { useEffect, useState } from "react";
import { renderMath } from "../../core/render/math";
import { renderMermaid } from "../visual/preview/controller";
import { checkMermaidBody } from "../visual/preview/policy";
import "katex/dist/katex.min.css";

export function MathPreview({ source, display = false }: { source: string; display?: boolean }) {
  try { return <span className={display ? "math-display" : "math-inline"} dangerouslySetInnerHTML={{ __html: renderMath(source, display) }} />; }
  catch (error) { return <span className="math-error"><code>{source}</code><span role="alert">{String(error)}</span></span>; }
}

/** Serialized renderer is cancellable in its isolated native worker. SVG stays an inert image. */
export function MermaidPreview({ source }: { source: string }) {
  const [state, setState] = useState<{ source: string; url?: string; error?: string } | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    let url: string | undefined;
    void (async () => {
      checkMermaidBody(source);
      const svg = await renderMermaid(source, abort.signal);
      if (abort.signal.aborted) return;
      url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      setState({ source, url });
    })().catch((error) => { if (!abort.signal.aborted) setState({ source, error: String(error) }); });
    return () => { abort.abort(); if (url) URL.revokeObjectURL(url); };
  }, [source]);
  return state?.source === source && state.url ? <img className="diagram-preview" src={state.url} alt="Mermaid diagram" /> : <div><pre>{source}</pre>{state?.source === source && state.error && <p role="alert">{state.error}</p>}</div>;
}
