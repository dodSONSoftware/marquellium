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
  useEffect(() => {
    const scope = subscriptionScope((error) => setMessage(String(error)));
    const unsubscribe = store.subscribe(() => {
      const doc = store.get(docId);
      if (doc) setSnapshot({ docId, revision: doc.revision, text: store.content(docId) });
    });
    let disposed = false;
    let ready = false;
    let released = false;
    let closing = false;
    scope.add(onMenuCommand((id) => {
      if (id === "save" || id === "save_as") void saveRef.current(id === "save_as");
      else setMessage("This prototype is pinned to one document. Use the Source window for navigation.");
    }));
    scope.add(onDocumentUpdated((update) => store.applyUpdate(update)));
    scope.add(onDocumentSaved(({ docId }) => {
      void store.refreshSavedDocument(docId).catch((error) => setMessage(`Save status refresh failed: ${error}`));
    }));
    scope.add(onWindowCloseRequested(() => {
      if (closing) return;
      closing = true;
      void (async () => {
        if (!ready || activity.current.opening) { setMessage("Wait for the editor to finish opening."); return; }
        if ((activity.current.draft && !activity.current.draft.closed) || activity.current.direct?.hasPending) {
          setMessage("Resolve the inline draft or pending text edit before closing this prototype."); return;
        }
        await store.flushAll();
        if (store.isDirty(docId)) { setMessage("Save the applied document changes before closing this prototype."); return; }
        if (!released) { await store.release(docId); released = true; }
        try { await native.confirmWindowClose(); }
        catch (error) { await native.documents.acquire(docId); released = false; throw error; }
      })().catch((error) => setMessage(String(error))).finally(() => { closing = false; });
    }));
    void store.attachDocument(docId).then(() => {
      ready = true;
      if (disposed && !released) { released = true; void store.release(docId).catch(() => {}); }
      else setMessage("M3V development prototype. Inline drafts are not crash-persistent yet.");
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
  return <main className="prototype-app">
    <header className="prototype-toolbar"><strong>M3V Visual prototype</strong>
      <button disabled={busy} onClick={() => void save()}>Save applied changes</button>
      <button disabled={busy} onClick={() => void store.undo(docId).catch((error) => setMessage(String(error)))}>Undo document</button>
      <button disabled={busy} onClick={() => void store.redo(docId).catch((error) => setMessage(String(error)))}>Redo document</button>
    </header>
    <p role="status">{message}</p>
    {snapshot && <VisualSurface snapshot={snapshot} store={store} onActivity={onActivity} />}
  </main>;
}
