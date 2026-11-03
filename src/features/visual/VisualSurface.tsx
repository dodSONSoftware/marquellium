import { displayedText, displaySourceOffset, sourceDisplayOffset } from "./direct-adapter";
import { editMappedBlock } from "../../core/localized-edit";
import { applyEditCommand, type EditCommandId } from "../editor/edit-commands";
import { newTable } from "../../core/table-edit";
import { TableTools } from "./TableTools";
import { MathPreview } from "../reader/TechnicalPreview";
import { useSourceMap } from "./useSourceMap";
import { createElement, Fragment, useEffect, useReducer, useRef, useState } from "react";
import { DraftSession } from "../../core/draft-session";
import { createSourceMap, type DocumentSourceMap, type MappedBlock, type MappedNode, type SourceSnapshot } from "../../core/source-map";
import type { DocumentStore } from "../documents/DocumentStore";
import { Reader } from "../reader/Reader";
import { InlineSourceEditor } from "./InlineSourceEditor";
import { DirectTextController, editableText } from "./direct-edit";
import { PreviewController, type MermaidRenderer } from "./preview/controller";
import { DraftPreview } from "./preview/Preview";
import "./visual.css";
import { type ViewContext, restoreContext } from "../../core/view-context";
import { ByteIndex } from "../../core/positions";

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

/** Revision-bound Visual editing surface; large/unknown constructs retain explicit source editing. */
export function VisualSurface({ snapshot, store, onActivity, renderer, beforeOpen, context, onContext, docPath = null, onOpenLocal = noLink, onOpenExternal = noLink }: {
  docPath?: string | null;
  onOpenLocal?: (relative: string) => void;
  onOpenExternal?: (url: string) => void;
  snapshot: SourceSnapshot;
  context?: ViewContext | null;
  onContext?: (context: ViewContext) => void;
  store: VisualDocumentPort;
  onActivity?: (activity: PrototypeActivity) => void;
  renderer?: MermaidRenderer;
  beforeOpen?: (docId: string) => Promise<boolean>;
}) {
  const selection = useRef<ViewContext | null>(null);
  const [page, setPage] = useState(0);
  const navigatedContext = useRef<ViewContext | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(true);
  const openRequest = useRef(false);
  const [direct, setDirect] = useState<{ key: number; model: DirectTextController; map: DocumentSourceMap } | null>(null);
  const [draft, setDraft] = useState<{ session: DraftSession; preview: PreviewController; map: DocumentSourceMap; start: number } | null>(null);
  const { map: liveMap, mapping, error: mappingError } = useSourceMap(snapshot);
  useEffect(() => {
    if (opening || !context || context === navigatedContext.current || !liveMap || !surface.current) return;
    const selection = restoreContext(context, snapshot.text);
    const blockIndex = liveMap.blocks.findIndex((block) => block.range.to >= selection.anchor);
    const targetPage = Math.floor(Math.max(0, blockIndex) / 60);
    if (targetPage !== page) { setPage(targetPage); return; }
    navigatedContext.current = context;
    const inputs = [...surface.current.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input[data-source-from], textarea[data-source-from]")];
    const input = inputs.find((input) => Number(input.dataset.sourceFrom) <= selection.anchor && Number(input.dataset.sourceTo) >= selection.head && Number(input.dataset.sourceTo) >= selection.anchor);
    if (input) {
      input.focus({ preventScroll: true });
      const find = (node: MappedNode): MappedNode | undefined => node.type === "text" && node.range.from === Number(input.dataset.sourceFrom) ? node : node.children.map(find).find(Boolean);
      const leaf = liveMap.blocks.map((b) => find(b.node)).find(Boolean);
      if (leaf) input.setSelectionRange(sourceDisplayOffset(leaf, Math.min(selection.anchor, selection.head) - leaf.range.from), sourceDisplayOffset(leaf, Math.max(selection.anchor, selection.head) - leaf.range.from), selection.anchor > selection.head ? "backward" : "forward");
      input.scrollIntoView?.({ block: "center" });
    } else {
      const sections = [...surface.current.querySelectorAll<HTMLElement>("[data-block-from]")];
      const block = sections.reverse().find((section) => Number(section.dataset.blockFrom) <= selection.anchor);
      block?.focus({ preventScroll: true });
      block?.scrollIntoView?.({ block: "center" });
    }
  }, [context, page, opening, liveMap]);
  useEffect(() => () => onActivity?.({ draft: null, direct: null }), []);
  useEffect(() => { if (liveMap && page * 60 >= liveMap.blocks.length) setPage(0); }, [liveMap, page]);
  const heldDirect = direct?.model.hasPending ? direct : null;
  const map = draft?.map ?? (direct?.model.revision === snapshot.revision ? direct.model.sourceMap : heldDirect?.map) ?? liveMap;
  useEffect(() => {
    onActivity?.({ draft: draft?.session ?? null, direct: direct?.model ?? null, opening });
  });
  useEffect(() => direct?.model.subscribe(refresh), [direct]);
  useEffect(() => {
    if (!draft) return;
    const a = draft.session.subscribe(refresh), b = draft.preview.subscribe(refresh);
    return () => { a(); b(); draft.preview.dispose(); };
  }, [draft]);

  useEffect(() => {
    if (draft?.session.closed) {
      draft.preview.dispose(); setDraft(null);
      onActivity?.({ draft: null, direct: direct?.model ?? null });
    }
  });

  useEffect(() => {
    let stopped = false;
    setOpening(true);
    void (async () => {
      const lease = await store.draftPort.info(snapshot.docId);
      if (stopped || !lease || lease.ownerWindow !== null) return;
      const fresh = await store.captureSourceSnapshot(snapshot.docId);
      const map = createSourceMap(fresh, { maxDepth: 32, maxNodes: 200_000 });
      const index = new ByteIndex(fresh.text);
      const block = map.blocks.find((block) => index.byteOffset(block.range.from) === lease.opening.startByte && index.byteOffset(block.range.to) === lease.opening.endByte);
      if (!block) throw new Error("Recovered draft block is unavailable. Its durable recovery record is retained.");
      const preview = new PreviewController(lease.opening.kind, renderer);
      try {
        const session = await DraftSession.resume(map, block, store.draftPort, (text) => preview.validate(text));
        if (!stopped) setDraft({ session, preview, map, start: block.range.from });
        else preview.dispose();
      } catch (error) { preview.dispose(); throw error; }
    })().catch((error) => { if (!stopped) setError(String(error)); }).finally(() => { if (!stopped) setOpening(false); });
    return () => { stopped = true; };
  }, [snapshot.docId, store]);

  const replaceBlock = async (block: MappedBlock, source: string) => {
    if (!map || draft || opening || heldDirect) return;
    try {
      setError(null);
      await store.applyLocalizedEdit(editMappedBlock(map, block, source));
      setDirect(null);
    } catch (error) { setError(String(error)); }
  };
  const insertBlock = async (source: string) => {
    if (draft || opening || heldDirect) return;
    try {
      const fresh = await store.captureSourceSnapshot(snapshot.docId);
      const from = fresh.text.length as MappedNode["range"]["from"];
      const range = { docId: fresh.docId, revision: fresh.revision, from, to: from };
      const ending = fresh.text.match(/\r\n|\r|\n/)?.[0] ?? "\n";
      const replacementText = (fresh.text ? ending + ending : "") + source.replace(/\n/g, ending);
      await store.applyLocalizedEdit({ docId: fresh.docId, baseRevision: fresh.revision, authorizedRange: range, range, openingText: "", replacementText });
      setDirect(null);
    } catch (error) { setError(String(error)); }
  };
  useEffect(() => {
    const command = (event: Event) => {
      const id = (event as CustomEvent<EditCommandId>).detail;
      void (async () => {
        await direct?.model.settle();
        if (draft || opening || direct?.model.hasPending) return;
        const fresh = await store.captureSourceSnapshot(snapshot.docId);
        const current = createSourceMap(fresh);
        const position = selection.current ? restoreContext(selection.current, fresh.text) : { anchor: 0, head: 0 };
        const from = Math.min(position.anchor, position.head), to = Math.max(position.anchor, position.head);
        const block = current.blocks.find((b) => b.range.from <= from && b.range.to >= to);
        if (!block) { setError("Select a block before formatting, or insert a new block."); return; }
        const result = applyEditCommand(block.source, { from: from - block.range.from, to: to - block.range.from }, id, fresh.text.match(/\r\n|\r|\n/)?.[0] ?? "\n");
        if (result) await store.applyLocalizedEdit(editMappedBlock(current, block, result.text));
        setDirect(null);
      })().catch((error) => setError(String(error)));
    };
    window.addEventListener("visual-command", command);
    return () => window.removeEventListener("visual-command", command);
  }, [snapshot.docId, store, draft, opening, direct]);

  const openSource = async (block: MappedBlock) => {
    if (!map || draft || opening || heldDirect || openRequest.current) return;
    openRequest.current = true;
    let preview: PreviewController | null = null;
    try {
      if (beforeOpen && await store.draftPort.info(snapshot.docId) && !await beforeOpen(snapshot.docId)) return;
      setOpening(true);
      onActivity?.({ draft: null, direct: direct?.model ?? null, opening: true });
      setError(null);
      const kind = block.node.type === "table" ? "table" : block.capability === "mermaid-draft" ? "mermaid" : block.node.type === "math" ? "math" : "source";
      const controller = new PreviewController(kind, renderer);
      preview = controller;
      const session = await DraftSession.open(map, block, kind, store.draftPort, (text) => controller.validate(text));
      setDraft({ session, preview: controller, map, start: block.range.from });
    } catch (error) { preview?.dispose(); setError(String(error)); }
    finally { openRequest.current = false; setOpening(false); }
  };

  const textInput = (leaf: MappedNode, label: string) => {
    if (!editableText(leaf)) return <span>{leaf.decodedText ?? leaf.source}</span>;
    const active = direct?.key === leaf.range.from ? direct : null;
    const model = active && (active.model.hasPending || active.model.revision === map?.snapshot.revision) ? active.model : null;
    const value = model?.display ?? displayedText(leaf);
    const TextField = value.includes("\n") ? "textarea" : "input";
    return <TextField data-source-from={leaf.exactText ? leaf.range.from : undefined} data-source-to={leaf.exactText ? leaf.range.to : undefined}
      onMouseUp={(event) => {
        const input = event.currentTarget; if (!map) return;
        selection.current = { text: map.snapshot.text, anchor: leaf.range.from + displaySourceOffset(leaf, input.selectionStart ?? 0), head: leaf.range.from + displaySourceOffset(leaf, input.selectionEnd ?? 0) };
        onContext?.(selection.current);
      }}
      onSelect={(event) => {
        if (!map) return;
        const input = event.currentTarget;
        const a = input.selectionStart ?? 0, b = input.selectionEnd ?? a;
        selection.current = { text: map.snapshot.text, anchor: leaf.range.from + displaySourceOffset(leaf, input.selectionDirection === "backward" ? b : a), head: leaf.range.from + displaySourceOffset(leaf, input.selectionDirection === "backward" ? a : b) };
        onContext?.(selection.current);
      }} aria-label={label} className="visual-text" value={value}
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
      case "linkReference":
      case "link": return <span className="visual-link" title="Link text; destination preserved">{children}</span>;
      case "inlineMath": return <MathPreview source={node.value ?? ""} />;
      case "imageReference":
      case "image": return <Reader content={node.source + "\n\n" + (map?.blocks.filter((b) => b.node.type === "definition").map((b) => b.source).join("\n") ?? "")} docPath={docPath} onOpenLocal={onOpenLocal} onOpenExternal={onOpenExternal} />;
      case "inlineCode": return <code>{node.source.replace(/^`+|`+$/g, "")}</code>;
      case "break": return <br />;
      default: return <span>{children}</span>;
    }
  };
  const body = (block: MappedBlock) => {
    if (block.source.length > 16_384 || block.node.type === "table" && (block.node.children.length > 100 || block.node.children.some((row) => row.children.length > 20))) {
      return <><p>Source-only block: Visual preview budget exceeded.</p><pre>{block.source.slice(0, 1024)}…</pre></>;
    }
    if (block.node.type === "math") return <MathPreview source={block.node.value ?? ""} display />;
    if (block.node.type === "code" && block.capability !== "mermaid-draft") return <Reader content={block.source} docPath={docPath} onOpenLocal={onOpenLocal} onOpenExternal={onOpenExternal} />;
    if (block.capability === "mermaid-draft") return <CanonicalDiagram source={block.source} renderer={renderer} />;
    if (block.capability === "text-candidate") {
      const renderNode = (node: MappedNode): React.ReactNode => {
        const children = node.children.map((child) => <Fragment key={child.range.from}>{renderNode(child)}</Fragment>);
        switch (node.type) {
          case "heading": return createElement(`h${node.depth ?? 1}`, {}, children);
          case "paragraph": return <p>{children}</p>;
          case "blockquote": return <blockquote>{children}</blockquote>;
          case "list": return node.ordered ? <ol start={node.start ?? 1}>{children}</ol> : <ul>{children}</ul>;
          case "listItem": return <li>{node.checked !== null && node.checked !== undefined && <input aria-label="Toggle task" type="checkbox" checked={node.checked} disabled={!!draft || !!heldDirect || opening} onChange={() => {
            const local = node.range.from - block.range.from;
            const item = block.source.slice(local, node.range.to - block.range.from);
            const updated = item.replace(/^(\s*(?:[-+*]|\d+[.)])\s+)\[[ xX]\]/, `$1[${node.checked ? " " : "x"}]`);
            void replaceBlock(block, block.source.slice(0, local) + updated + block.source.slice(node.range.to - block.range.from));
          }} />}{children}</li>;
          default: return inline(node, `Edit ${block.node.type} text`);
        }
      };
      return renderNode(block.node);
    }
    if (block.capability === "table-candidate") {
      return <><table><tbody>{block.node.children.map((row, rowIndex) => <tr key={row.range.from}>
        {row.children.map((cell, column) => createElement(rowIndex ? "td" : "th", {
          key: cell.range.from, style: { textAlign: block.node.align?.[column] ?? undefined },
        }, editableText(cell) ? textInput(cell, `Edit table cell ${rowIndex + 1},${column + 1}`) : cell.children.map((node) => <span key={node.range.from}>{inline(node, `Edit table cell ${rowIndex + 1},${column + 1}`)}</span>)))}
      </tr>)}</tbody></table><TableTools block={block} disabled={!!draft || !!heldDirect || opening} onEdit={(source) => void replaceBlock(block, source)} /></>;
    }
    return <><p className="protected-label">Protected source — use explicit source editing</p><Reader docPath={docPath} onOpenLocal={onOpenLocal} onOpenExternal={onOpenExternal} content={block.source} /></>;
  };
  return <div ref={surface} className="reader visual-surface" onKeyDown={(event) => {
      if (!(event.metaKey || event.ctrlKey) || (event.target as HTMLElement).closest('[aria-label="Inline source draft"]')) return;
      const id = ({ b: "bold", i: "italic", e: "code", k: "link" } as Record<string, EditCommandId>)[event.key.toLowerCase()];
      if (id) { event.preventDefault(); window.dispatchEvent(new CustomEvent("visual-command", { detail: id })); }
    }}>
    <details className="visual-insert"><summary>Insert block</summary>
      {Object.entries({ Paragraph: "New paragraph.", Heading: "## New heading", List: "- New item", Quote: "> New quote", Code: "```text\nNew code\n```", Table: newTable, Math: "$$\nx^2\n$$", Mermaid: "```mermaid\nflowchart LR\n A[Start] --> B[Done]\n```" }).map(([label, source]) => <button key={label} disabled={!!draft || opening || !!heldDirect} onClick={() => void insertBlock(source)}>Insert {label.toLowerCase()}</button>)}
    </details>
    {error && <p role="alert">{error}</p>}
    {direct?.model.error && <section role="alert"><p>{direct.model.error}</p>
      <textarea aria-label="Retained uncommitted text" readOnly value={direct.model.display} />
      <button onClick={() => { setDirect(null); onActivity?.({ draft: draft?.session ?? null, direct: null }); }}>Cancel pending text</button>
    </section>}
    {mapping && <p role="status">Mapping document…</p>}
    {mappingError && <p role="alert">{mappingError}. Source remains available.</p>}
    {!map && !mapping && !mappingError && <p>Document exceeds the Visual mapping limit. Continue editing in the Source window.</p>}
    {map && map.blocks.length > 60 && <nav aria-label="Document blocks">
      <button disabled={page === 0 || !!draft || !!heldDirect} onClick={() => setPage(page - 1)}>Previous blocks</button>
      <span> Blocks {page * 60 + 1}–{Math.min((page + 1) * 60, map.blocks.length)} of {map.blocks.length} </span>
      <button disabled={(page + 1) * 60 >= map.blocks.length || !!draft || !!heldDirect} onClick={() => setPage(page + 1)}>Next blocks</button>
    </nav>}
    {map?.blocks.slice(page * 60, (page + 1) * 60).map((block) => <section tabIndex={-1} data-block-from={block.range.from} onFocus={(event) => { if (event.target === event.currentTarget) onContext?.({ text: map.snapshot.text, anchor: block.range.from, head: block.range.from }); }} className="visual-block" key={`${block.range.from}-${block.node.type}`}>
      {draft?.start === block.range.from ? <>
        <DraftPreview preview={draft.preview.lastValid} {...readerProps} />
        <InlineSourceEditor session={draft.session} onClosed={() => {
          draft.preview.dispose(); setDraft(null); onActivity?.({ draft: null, direct: direct?.model ?? null });
        }} />
      </> : <>{body(block)}<button disabled={!!draft || !!heldDirect || opening} onClick={() => void openSource(block)}>Edit {block.node.type === "table" ? "table" : block.capability === "mermaid-draft" ? "Mermaid" : block.node.type === "math" ? "math" : "block"} source</button><button disabled={!!draft || !!heldDirect || opening} onClick={() => void replaceBlock(block, "")}>Remove block</button></>}
    </section>)}
  </div>;
}
