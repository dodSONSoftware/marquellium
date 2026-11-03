import { undo as undoDraft, redo as redoDraft } from "@codemirror/commands";
import { useLifecycle } from "../documents/useLifecycle";
import { useCallback, useEffect, useRef, useState } from "react";
import { DocumentStore } from "../documents/DocumentStore";
import { native, onDocumentUpdated, onDocumentSaved, onWindowCloseRequested, onMenuCommand } from "../../services/native";
import { subscriptionScope } from "../../services/subscription-scope";
import { VisualSurface, type PrototypeActivity } from "./VisualSurface";
import type { SourceSnapshot } from "../../core/source-map";

/** Development-only harness: real registry, pinned document, no mode/tab navigation. */
export function PrototypeApp({ docId }: { docId: string }) {
  const [store] = useState(() => new DocumentStore());
  const [snapshot, setSnapshot] = useState<SourceSnapshot | null>(null);
  const [message, setMessage] = useState("Opening prototype…");
  const activity = useRef<PrototypeActivity>({ draft: null, direct: null });
  const [busy, setBusy] = useState(false);
  const saveRef = useRef<(saveAs?: boolean) => Promise<void>>(async () => {});
  const onActivity = useCallback((next: PrototypeActivity) => {
    activity.current = next;
    setBusy(!!next.opening || !!next.draft && !next.draft.closed || !!next.direct?.hasPending);
  }, []);
  const lifecycle = useLifecycle(store, () => activity.current, setMessage, () => snapshot !== null);
  const lifecycleRef = useRef(lifecycle);
  lifecycleRef.current = lifecycle;
  useEffect(() => {
    const scope = subscriptionScope((error) => setMessage(String(error)));
    const unsubscribe = store.subscribe(() => {
      const doc = store.get(docId);
      if (doc) setSnapshot({ docId, revision: doc.revision, text: store.content(docId) });
    });
    let disposed = false;
    let ready = false;
    let released = false;
    scope.add(onMenuCommand((id) => {
      if (id === "save" || id === "save_as") void saveRef.current(id === "save_as");
      else if (id.startsWith("history:")) {
        const draft = activity.current.draft;
        if (draft && !draft.closed) (id === "history:redo" ? redoDraft : undoDraft)({ state: draft.state, dispatch: (transaction) => draft.dispatch(transaction) });
        else void (id === "history:redo" ? store.redo(docId) : store.undo(docId)).catch((error) => setMessage(String(error)));
      }
      else setMessage("This prototype is pinned to one document. Use the Source window for navigation.");
    }));
    scope.add(onDocumentUpdated((update) => store.applyUpdate(update)));
    scope.add(onDocumentSaved(({ docId }) => {
      void store.refreshSavedDocument(docId).catch((error) => setMessage(`Save status refresh failed: ${error}`));
    }));
    scope.add(onWindowCloseRequested(() => {
      void lifecycleRef.current.begin("close-window");
    }));
    void store.attachDocument(docId).then(() => {
      ready = true;
      if (disposed && !released) { released = true; void store.release(docId).catch(() => {}); }
      else setMessage("M3V development prototype. Draft recovery is enabled. Resolve drafts before navigation or closing.");
    }).catch((error) => setMessage(String(error)));
    return () => { disposed = true; unsubscribe(); scope.dispose(); if (ready && !released) { released = true; void store.release(docId).catch(() => {}); } };
  }, [store, docId]);
  const save = async (saveAs = false) => {
    if (activity.current.opening || activity.current.direct?.hasPending || activity.current.draft && !activity.current.draft.closed) {
      setMessage("Apply or Cancel the inline editor first."); return;
    }
    try {
      const doc = store.get(docId);
      const path = doc?.path && !saveAs ? null : await native.dialogs.saveMarkdown("prototype.md");
      if ((!doc?.path || saveAs) && !path) return;
      const result = path ? await store.saveAs(docId, path) : await store.save(docId);
      setMessage(result.ok ? "Applied changes saved." : `Save failed: ${result.message}`);
    } catch (error) { setMessage(String(error)); }
  };
  saveRef.current = save;
  return <><main inert={lifecycle.blocked} className="prototype-app">
    <header className="prototype-toolbar"><strong>Marquellium — M3V prototype</strong>
      <button disabled={busy} onClick={() => void save()}>Save applied changes</button>
      <button disabled={busy} onClick={() => void store.undo(docId).catch((error) => setMessage(String(error)))}>Undo document</button>
      <button disabled={busy} onClick={() => void store.redo(docId).catch((error) => setMessage(String(error)))}>Redo document</button>
    </header>
    <p role="status">{message}</p>
    {snapshot && <VisualSurface snapshot={snapshot} store={store} onActivity={onActivity} beforeOpen={(docId) => lifecycleRef.current.begin("mode-switch", [docId])} />}
  </main>{lifecycle.dialog}</>;
}
