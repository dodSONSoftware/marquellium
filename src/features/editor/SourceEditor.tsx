import { SourceBuffer } from "../../core/source-buffer";
import { type ViewContext, restoreContext } from "../../core/view-context";
/**
 * Source mode on CodeMirror 6 (FR-011, FR-040, ADR-006/007/010).
 *
 * Contract with the document registry:
 *  - local edits are converted to minimal BYTE ops (core/positions.ts) and
 *    handed to `DocumentStore.editGroup`, which batches a keystroke burst
 *    into ONE registry transaction (undo granularity = edit group);
 *  - the editor has NO local history: Mod-Z / Shift-Mod-Z go to the shared
 *    registry history (FR-040/AT-103) — mode switching never adds an undo
 *    entry because switching touches no document state;
 *  - the mirror (props.content) is the registry's truth. When it changes
 *    for a reason that is not our in-flight group (undo/redo, another
 *    window, conflict resync), the document is replaced and the selection
 *    is mapped through the minimal diff (FR-041 basic).
 *
 * The view stays mounted across mode switches (App toggles visibility),
 * so cursor/selection survive Source↔Read↔Split (FR-012B, AT-102 basic).
 */
import { useEffect, useRef } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { search, searchKeymap } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";

import { ByteIndex, changesToByteOps, type Change } from "../../core/positions";
import { diffRange, mapPositions } from "../../core/text-diff";
import {
  applyEditCommand,
  type EditCommandId,
} from "./edit-commands";
import type { DocumentStore } from "../documents/DocumentStore";
import "./editor.css";

const MD_HIGHLIGHT = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.35em", fontWeight: "600" },
  { tag: t.heading2, fontSize: "1.2em", fontWeight: "600" },
  { tag: t.heading3, fontSize: "1.1em", fontWeight: "600" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "600" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--accent)" },
  { tag: t.url, color: "var(--muted)", textDecoration: "underline" },
  { tag: t.monospace, fontFamily: "var(--reader-mono, monospace)", color: "var(--hl-attr)" },
  { tag: t.quote, color: "var(--muted)", fontStyle: "italic" },
  { tag: t.list, color: "var(--hl-keyword)" },
  { tag: t.contentSeparator, color: "var(--muted)" },
  { tag: t.processingInstruction, color: "var(--muted)" },
]);

export interface SourceEditorProps {
  spellcheck?: boolean;
  docId: string;
  /** Registry-truth content for this document (the store mirror). */
  content: string;
  store: DocumentStore;
  /** Exposes the CM view (toolbar commands, focus management). */
  onView?: (view: EditorView | null) => void;
}

const buffers = new WeakMap<EditorView, SourceBuffer>();
export function sourceContext(view: EditorView): ViewContext {
  const buffer = buffers.get(view) ?? new SourceBuffer(view.state.doc.toString());
  const selection = view.state.selection.main;
  return { text: buffer.text, anchor: buffer.rawOffset(selection.anchor), head: buffer.rawOffset(selection.head) };
}
export function restoreSourceContext(view: EditorView, context: ViewContext): void {
  const buffer = buffers.get(view) ?? new SourceBuffer(view.state.doc.toString());
  const mapped = restoreContext(context, buffer.text);
  const selection = { anchor: buffer.editorOffset(mapped.anchor), head: buffer.editorOffset(mapped.head) };
  view.dispatch({ selection, effects: EditorView.scrollIntoView(selection.head, { y: "center" }) });
}

/** Translate scroll/navigation positions through the raw-ending adapter. */
export function sourceScrollOffset(view: EditorView): number {
  const offset = view.lineBlockAtHeight(Math.max(0, view.scrollDOM.scrollTop - view.documentPadding.top)).from;
  return buffers.get(view)?.rawOffset(offset) ?? offset;
}
export function scrollSourceOffset(view: EditorView, rawOffset: number): void {
  const offset = buffers.get(view)?.editorOffset(rawOffset) ?? rawOffset;
  view.dispatch({ effects: EditorView.scrollIntoView(offset, { y: "start" }) });
}

export function SourceEditor({ docId, content, store, onView, spellcheck = true }: SourceEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const bufferRef = useRef(new SourceBuffer(content));
  const indexRef = useRef<ByteIndex | null>(null);
  // The last mirror content the view has reconciled with. While a local
  // group is in flight the mirror is older than the view's document; that
  // staleness must not be mistaken for an external change.
  const lastReconciledRef = useRef(content);
  // Set while a reconciliation dispatch is in flight so the update
  // listener does not re-commit the EXTERNAL change as a local edit
  // (e.g. undo would otherwise be re-applied to the registry).
  const suppressRef = useRef(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const commandKeymap: Extension = keymap.of(
      [
        // Shared history (FR-040): undo/redo belong to the registry, not
        // to this view. Bound before defaultKeymap so they win.
        {
          key: "Mod-z",
          run: () => {
            void store.undo(docId).catch(() => {});
            return true;
          },
          preventDefault: true,
          exact: true,
        },
        {
          key: "Shift-Mod-z",
          run: () => {
            void store.redo(docId).catch(() => {});
            return true;
          },
          preventDefault: true,
          exact: true,
        },
        {
          key: "Mod-y",
          run: () => {
            void store.redo(docId).catch(() => {});
            return true;
          },
          preventDefault: true,
          exact: true,
        },
        ...editCommandBindings(() => viewRef.current),
        ...searchKeymap,
        ...defaultKeymap,
      ],
    );

    const updateListener = EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      if (suppressRef.current) return; // reconciliation, not a user edit
      const changes: Change[] = [];
      update.changes.iterChanges((fromA, toA, _fB, _tB, inserted) => {
        changes.push({ fromA, toA, inserted: inserted.toString() });
        return false;
      });
      const index = indexRef.current;
      if (!index) return;
      const converted = bufferRef.current.changes(changes);
      const ops = changesToByteOps(index, converted.changes);
      const newText = converted.next.text;
      bufferRef.current = converted.next;
      buffers.set(update.view, converted.next);
      if (ops === null) {
        // A boundary split a surrogate pair: minimal ops are impossible,
        // fall back to a full-buffer replace against the registry state.
        // Flush the in-flight group first so the replace applies after it.
        void (async () => {
          await store.flushGroup(docId);
          const doc = store.get(docId);
          if (!doc) return;
          try {
            await store.editFullContent(docId, newText);
          } catch {
            // resync in the store will reconcile the view.
          }
        })();
      } else {
        store.editGroup(docId, ops);
      }
      index.sync(newText, converted.changes);
    });

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: bufferRef.current.normalized,
        extensions: [
          EditorView.contentAttributes.of({ spellcheck: String(spellcheck), "aria-label": "Markdown source" }),
          EditorView.lineWrapping,
          EditorState.tabSize.of(4),
          // A megabyte-long line makes the Markdown parser synchronous per key.
          // Keep it editable as plain Source; ordinary documents retain highlighting.
          ...(bufferRef.current.normalized.split("\n").some((line) => line.length > 8192) ? [] : [markdown(), syntaxHighlighting(MD_HIGHLIGHT, { fallback: true })]),
          search({ top: true }),
          commandKeymap,
          updateListener,
        ],
      }),
    });
    buffers.set(view, bufferRef.current);
    view.focus();
    viewRef.current = view;
    indexRef.current = new ByteIndex(content);
    lastReconciledRef.current = content;
    onView?.(view);

    return () => {
      onView?.(null);
      view.destroy();
      viewRef.current = null;
      indexRef.current = null;
    };
    // The view is created once per document (App keys the component by
    // docId); content changes flow through the reconciliation effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  useEffect(() => { viewRef.current?.contentDOM.setAttribute("spellcheck", String(spellcheck)); }, [spellcheck]);

  // Reconcile with the mirror (external changes: undo/redo, other windows,
  // conflict resync). Local in-flight groups leave the mirror stale; that
  // is exactly `content === lastReconciled` and is ignored.
  useEffect(() => {
    const view = viewRef.current;
    const index = indexRef.current;
    if (!view || !index) return;
    const docText = bufferRef.current.text;
    if (content === docText) {
      lastReconciledRef.current = content;
      return;
    }
    if (content === lastReconciledRef.current) return; // in-flight group
    // The view is AHEAD of the mirror by an in-flight group (e.g. the
    // previous group's broadcast landed while the user kept typing).
    // The mirror will catch up on that broadcast's echo — dispatching
    // now would delete the user's own uncommitted keystrokes.
    const projected = store.projectedText(docId);
    if (projected !== null && projected === docText) return;
    const sel = view.state.selection.main;
    const nextBuffer = new SourceBuffer(content);
    const change = diffRange(view.state.doc.toString(), nextBuffer.normalized);
    const mapped = mapPositions(view.state.doc.length, change, sel.from, sel.to);
    bufferRef.current = nextBuffer;
    buffers.set(view, nextBuffer);
    suppressRef.current = true;
    try {
      view.dispatch({
        changes: change,
        selection: { anchor: mapped.from, head: mapped.to },
      });
    } finally {
      suppressRef.current = false;
    }
    index.sync(content, []);
    lastReconciledRef.current = content;
  }, [content, docId]);

  return (
    <div
      className="editor-host"
      ref={hostRef}
      role="textbox"
      aria-label="Markdown source"
    />
  );
}

function editCommandBindings(getView: () => EditorView | null) {
  const run = (cmd: EditCommandId) => {
    const view = getView();
    if (!view || view.state.readOnly) return false;
    // The updateListener (synchronous inside dispatch) converts the
    // resulting document change into minimal byte ops.
    return dispatchCommand(view, cmd);
  };
  const b = (key: string, cmd: EditCommandId) => ({
    key,
    run: () => run(cmd),
    preventDefault: true,
    exact: true,
  });
  return [
    b("Mod-b", "bold"),
    b("Mod-i", "italic"),
    b("Mod-e", "code"),
    b("Mod-k", "link"),
    b("Mod-h", "heading"),
    b("Mod-Shift-8", "list"),
    b("Mod-Shift-9", "orderedList"),
    b("Mod-Shift-0", "quote"),
    b("Mod-Shift-f", "fence"),
    b("Mod-Shift-t", "task"),
  ];
}

/**
 * Apply an edit command to a view (keyboard bindings and the toolbar
 * share this). Returns false when nothing changed.
 */
function dispatchCommand(view: EditorView, cmd: EditCommandId): boolean {
  const { state } = view;
  const sel = state.selection.main;
  const oldText = state.doc.toString();
  const res = applyEditCommand(oldText, { from: sel.from, to: sel.to }, cmd);
  if (!res || res.text === oldText) return false;
  const change = diffRange(oldText, res.text);
  const mapped = mapPositions(oldText.length, change, sel.from, sel.to);
  view.dispatch({
    changes: change,
    selection: { anchor: mapped.from, head: mapped.to },
  });
  return true;
}

/** Toolbar entry point (the toolbar lives in App). */
export function runEditorCommand(
  view: EditorView | null,
  cmd: EditCommandId,
): boolean {
  if (!view || view.state.readOnly) return false;
  return dispatchCommand(view, cmd);
}
