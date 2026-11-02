import { createElement, useEffect, useMemo, useReducer, useState } from "react";
import { DraftSession } from "../../core/draft-session";
import { createSourceMap, type DocumentSourceMap, type MappedBlock, type MappedNode, type SourceSnapshot } from "../../core/source-map";
import type { DocumentStore } from "../documents/DocumentStore";
import { Reader } from "../reader/Reader";
import { InlineSourceEditor } from "./InlineSourceEditor";
import { DirectTextController, editableText } from "./direct-edit";
import { PreviewController, type MermaidRenderer } from "./preview/controller";
import { DraftPreview } from "./preview/Preview";
import "./visual.css";

export type VisualDocumentPort = Pick<DocumentStore, "captureSourceSnapshot" | "applyLocalizedEdit" | "draftPort">;

export interface PrototypeActivity { draft: DraftSession | null; direct: DirectTextController | null; opening?: boolean }
const noLink = () => {};
const readerProps = { docPath: null, onOpenLocal: noLink, onOpenExternal: noLink };

function CanonicalDiagram({ source, renderer }: { source: string; renderer?: MermaidRenderer }) {
  const [state, setState] = useState<{ source: string; controller: PreviewController; error: string | null } | null>(null);
  useEffect(() => {
    const controller = new PreviewController("mermaid", renderer);
    let alive = true;
    setState({ source, controller, error: null });
    void controller.validate(source).then((result) => { if (alive) setState({ source, controller, error: result.valid ? null : result.diagnostics.join("\n") }); });
    return () => { alive = false; controller.dispose(); };
  }, [source, renderer]);
  const current = state?.source === source ? state : null;
  return current?.controller.lastValid ? <DraftPreview preview={current.controller.lastValid} {...readerProps} /> : <>
    {current?.error && <p role="alert">Diagram preview unavailable: {current.error}</p>}
    <Reader {...readerProps} content={source} />
  </>;
}

/** Opt-in, single-document prototype. Lifecycle dialogs and crash persistence remain package E. */
export function VisualSurface({ snapshot, store, onActivity, renderer }: {
  snapshot: SourceSnapshot;
  store: VisualDocumentPort;
  onActivity?: (activity: PrototypeActivity) => void;
  renderer?: MermaidRenderer;
}) {
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [direct, setDirect] = useState<{ key: number; model: DirectTextController; map: DocumentSourceMap } | null>(null);
  const [draft, setDraft] = useState<{ session: DraftSession; preview: PreviewController; map: DocumentSourceMap; start: number } | null>(null);
  const liveMap = useMemo(() => {
    if (new TextEncoder().encode(snapshot.text).length > 128 * 1024) return null;
    const lines = snapshot.text.split(/\r\n|\r|\n/);
    if (lines.length > 2000 || lines.some((line) => line.length > 8192 || /^ {65}|^(?: *> *){33}/.test(line))) return null;
    try {
      const map = createSourceMap(snapshot, { maxDepth: 32, maxNodes: 10_000 });
      return map.blocks.length > 500 ? null : map;
    } catch { return null; } // Source remains available in the main window; never return a partial map.
  }, [snapshot.docId, snapshot.revision, snapshot.text]);
  const heldDirect = direct?.model.hasPending ? direct : null;
  const map = draft?.map ?? heldDirect?.map ?? liveMap;
  useEffect(() => {
    onActivity?.({ draft: draft?.session ?? null, direct: direct?.model ?? null, opening });
  });
  useEffect(() => direct?.model.subscribe(refresh), [direct]);
  useEffect(() => {
    if (!draft) return;
    const a = draft.session.subscribe(refresh), b = draft.preview.subscribe(refresh);
    return () => { a(); b(); draft.preview.dispose(); };
  }, [draft]);

  const openSource = async (block: MappedBlock) => {
    if (!map || draft || opening || heldDirect) return;
    setOpening(true);
    onActivity?.({ draft: null, direct: direct?.model ?? null, opening: true });
    setError(null);
    const kind = block.node.type === "table" ? "table" : block.capability === "mermaid-draft" ? "mermaid" : "source";
    const preview = new PreviewController(kind, renderer);
    try {
      const session = await DraftSession.open(map, block, kind, store.draftPort, (text) => preview.validate(text));
      setDraft({ session, preview, map, start: block.range.from });
    } catch (error) { preview.dispose(); setError(String(error)); }
    finally { setOpening(false); }
  };

  const textInput = (leaf: MappedNode, label: string) => {
    if (!editableText(leaf)) return <span>{leaf.decodedText ?? leaf.source}</span>;
    const active = direct?.key === leaf.range.from ? direct : null;
    const model = active && (active.model.hasPending || active.model.revision === map?.snapshot.revision) ? active.model : null;
    const value = model?.display ?? leaf.decodedText ?? leaf.source;
    return <input aria-label={label} className="visual-text" value={value}
      style={{ width: `${Math.max(2, Math.min(value.length + 1, 80))}ch` }}
      disabled={!!draft || opening || (!!heldDirect && heldDirect.key !== leaf.range.from)}
      onChange={(event) => {
        if (!map) return;
        let current = model;
        if (!current) {
          current = new DirectTextController(map, leaf, store);
          setDirect({ key: leaf.range.from, model: current, map });
          onActivity?.({ draft: null, direct: current });
        }
        current.input(event.target.value);
        refresh();
      }} />;
  };
  const inline = (node: MappedNode, label: string): React.ReactNode => {
    if (node.type === "text") return textInput(node, label);
    const children = node.children.map((child) => <span key={child.range.from}>{inline(child, label)}</span>);
    switch (node.type) {
      case "strong": return <strong>{children}</strong>;
      case "emphasis": return <em>{children}</em>;
      case "delete": return <del>{children}</del>;
      case "link": return <span className="visual-link" title="Link text; destination preserved">{children}</span>;
      case "inlineCode": return <code>{node.source.replace(/^`+|`+$/g, "")}</code>;
      case "break": return <br />;
      default: return <span>{children}</span>;
    }
  };
  const body = (block: MappedBlock) => {
    if (block.source.length > 16_384 || block.node.type === "table" && (block.node.children.length > 100 || block.node.children.some((row) => row.children.length > 20))) {
      return <><p>Source-only block: prototype preview budget exceeded.</p><pre>{block.source.slice(0, 1024)}…</pre></>;
    }
    if (block.capability === "mermaid-draft") return <CanonicalDiagram source={block.source} renderer={renderer} />;
    if (block.capability === "text-candidate") {
      const children = block.node.children.map((node) => <span key={node.range.from}>{inline(node, `Edit ${block.node.type} text`)}</span>);
      return block.node.type === "heading" ? createElement(`h${block.node.depth ?? 1}`, {}, children) : <p>{children}</p>;
    }
    if (block.capability === "table-candidate") {
      return <table><tbody>{block.node.children.map((row, rowIndex) => <tr key={row.range.from}>
        {row.children.map((cell, column) => createElement(rowIndex ? "td" : "th", {
          key: cell.range.from, style: { textAlign: block.node.align?.[column] ?? undefined },
        }, cell.children.map((node) => <span key={node.range.from}>{inline(node, `Edit table cell ${rowIndex + 1},${column + 1}`)}</span>)))}
      </tr>)}</tbody></table>;
    }
    return <><p className="protected-label">Protected source — use explicit source editing</p><Reader {...readerProps} content={block.source} /></>;
  };
  return <div className="reader visual-surface">
    {error && <p role="alert">{error}</p>}
    {direct?.model.error && <section role="alert"><p>{direct.model.error}</p>
      <textarea aria-label="Retained uncommitted text" readOnly value={direct.model.display} />
      <button onClick={() => { setDirect(null); onActivity?.({ draft: draft?.session ?? null, direct: null }); }}>Cancel pending text</button>
    </section>}
    {!map && <p>Document exceeds the prototype mapping limit. Continue editing in the Source window.</p>}
    {map?.blocks.map((block) => <section className="visual-block" key={`${block.range.from}-${block.node.type}`}>
      {draft?.start === block.range.from ? <>
        <DraftPreview preview={draft.preview.lastValid} {...readerProps} />
        <InlineSourceEditor session={draft.session} onClosed={() => {
          draft.preview.dispose(); setDraft(null); onActivity?.({ draft: null, direct: direct?.model ?? null });
        }} />
      </> : <>{body(block)}<button disabled={!!draft || !!heldDirect || opening} onClick={() => void openSource(block)}>Edit {block.node.type === "table" ? "table" : block.capability === "mermaid-draft" ? "Mermaid" : "block"} source</button></>}
    </section>)}
  </div>;
}
