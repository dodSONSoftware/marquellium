import { renderMath } from "../../../core/render/math";
import { createSourceMap } from "../../../core/source-map";
import { invoke } from "@tauri-apps/api/core";
import type { DraftValidation } from "../../../core/draft-session";
import { mathBody, mermaidBody, validateSourcePreview, validateTable } from "./policy";

export interface PreviewResult { kind: "table" | "mermaid" | "math" | "source"; source: string; svg?: string }
export type MermaidRenderer = (source: string, signal: AbortSignal) => Promise<string>;
let nextRequest = 0;
let renderTail: Promise<unknown> = Promise.resolve();
export const renderMermaid: MermaidRenderer = (source, signal) => {
  const result = renderTail.catch(() => {}).then(() => renderMermaidNow(source, signal));
  renderTail = result;
  return result;
};
const renderMermaidNow: MermaidRenderer = async (source, signal) => {
  // Avoid starting a native WebKit process for every keystroke in a burst.
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new Error("preview cancelled")); return; }
    const abort = () => { clearTimeout(timer); reject(new Error("preview cancelled")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 150);
    signal.addEventListener("abort", abort, { once: true });
  });
  const requestId = `preview-${++nextRequest}`;
  const cancel = () => { void invoke("previews_cancel", { requestId }).catch(() => {}); };
  if (signal.aborted) throw new Error("preview cancelled");
  signal.addEventListener("abort", cancel, { once: true });
  try { return await invoke<string>("previews_mermaid", { source, requestId }); }
  finally { signal.removeEventListener("abort", cancel); }
};

/** Last-valid preview and cancellation are independent of canonical Markdown. */
export class PreviewController {
  private generation = 0;
  private pending: AbortController | null = null;
  private stopped = false;
  private result: PreviewResult | null = null;
  private listeners = new Set<() => void>();
  constructor(private readonly kind: PreviewResult["kind"], private readonly renderer: MermaidRenderer = renderMermaid) {}
  get lastValid(): PreviewResult | null { return this.result; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async validate(text: string): Promise<DraftValidation> {
    if (this.stopped) return { valid: false, diagnostics: ["preview closed"] };
    const generation = ++this.generation;
    this.pending?.abort();
    const request = new AbortController();
    this.pending = request;
    try {
      let svg: string | undefined;
      if (this.kind === "table") validateTable(text);
      else if (this.kind === "mermaid") svg = await this.renderer(mermaidBody(text), request.signal);
      else if (this.kind === "math") {
        validateSourcePreview(text);
        const map = createSourceMap({ docId: "math", revision: 0, text });
        if (map.blocks.length !== 1 || map.blocks[0]?.node.type !== "math") throw new Error("Draft must contain exactly one display math block");
        renderMath(mathBody(text), true);
      } else validateSourcePreview(text);
      if (this.stopped || generation !== this.generation) return { valid: false, diagnostics: ["obsolete preview"] };
      this.result = { kind: this.kind, source: text, ...(svg === undefined ? {} : { svg }) };
      for (const listener of this.listeners) listener();
      return { valid: true, diagnostics: [] };
    } catch (error) {
      return { valid: false, diagnostics: [String(error)] };
    }
  }
  dispose(): void { this.stopped = true; this.generation++; this.pending?.abort(); this.listeners.clear(); }
}
