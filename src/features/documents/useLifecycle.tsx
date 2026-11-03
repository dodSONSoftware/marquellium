import { useEffect, useRef, useState } from "react";
import type { DraftSession, DraftLease } from "../../core/draft-session";
import type { DirectTextController } from "../visual/direct-edit";
import type { DocumentStore } from "./DocumentStore";
import { native, isTauri, onLifecycleRequest, onLifecycleRelease, onLifecycleError, type LifecycleRequest, type LifecycleTrigger, type DocumentSnapshot } from "../../services/native";
import { subscriptionScope } from "../../services/subscription-scope";

type Activity = { draft: DraftSession | null; direct: DirectTextController | null; opening?: boolean };
type Prompt = { request: LifecycleRequest; lease?: DraftLease; snapshot?: DocumentSnapshot; finish: (value: string) => void };

/** Native serializes all participants; only the actual draft owner runs Apply. */
export function useLifecycle(store: Pick<DocumentStore, "flushAll" | "list">, activity: () => Activity, report: (message: string) => void, canPrepare: () => boolean = () => true) {
  const callbacks = useRef({ activity, report, canPrepare });
  callbacks.current = { activity, report, canPrepare };
  const [blocked, setBlocked] = useState(false);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<((value: string) => void) | null>(null);
  const transaction = useRef<number | null>(null);
  const latestTransaction = useRef(0);
  const seenRequests = useRef(new Set<number>());
  const localRequests = useRef(0);
  useEffect(() => {
    if (!isTauri()) return;
    const scope = subscriptionScope((error) => callbacks.current.report(`Lifecycle listener failed: ${error}`));
    const ask = (request: LifecycleRequest) => new Promise<string>((resolve) => {
      pending.current = resolve;
      setError(null);
      setPrompt({ request, lease: request.body.lease, snapshot: request.body.snapshot, finish: resolve });
    });
    scope.add(onLifecycleRequest((request) => {
      void (async () => {
        if (request.action === "prepare") {
          if (request.transaction <= latestTransaction.current) {
            if (request.transaction === transaction.current && seenRequests.current.has(request.id)) return;
            throw new Error("expired lifecycle preparation");
          }
          latestTransaction.current = request.transaction;
          seenRequests.current.clear();
        }
        if (seenRequests.current.has(request.id)) return;
        seenRequests.current.add(request.id);
        if (request.action !== "prepare" && transaction.current !== request.transaction) throw new Error("expired lifecycle request");
        const current = callbacks.current.activity();
        let value: unknown;
        switch (request.action) {
          case "prepare":
            transaction.current = request.transaction;
            setBlocked(true);
            if (!callbacks.current.canPrepare()) throw new Error("Resolve the existing dialog before retrying navigation or Quit.");
            if (current.opening) throw new Error("An edit is still in progress. Please try again when it finishes.");
            await current.direct?.settle();
            if (current.direct?.hasPending) throw new Error("Resolve or copy the retained direct edit before retrying.");
            await store.flushAll();
            value = store.list.map((document) => document.docId);
            break;
          case "resolve-draft": {
            const lease = request.body.lease!;
            if (lease.ownerWindow === null) { value = await ask(request); break; }
            if (!current.draft || current.draft.closed || current.draft.docId !== lease.docId) throw new Error("The draft owner is not ready. Its text is preserved; reopen the owning editor.");
            if (!current.draft.modified) { value = "discard"; break; }
            value = await ask(request);
            break;
          }
          case "discard-draft":
            if (!current.draft || current.draft.closed || current.draft.docId !== request.body.docId || current.draft.token !== request.body.token) throw new Error("Draft ownership changed before discard.");
            await current.draft.cancel();
            value = "discarded";
            break;
          case "resolve-canonical": value = await ask(request); break;
          default: throw new Error("Unknown lifecycle request");
        }
        await native.lifecycle.reply(request.id, value);
      })().catch((error) => {
        callbacks.current.report(String(error));
        void native.lifecycle.reply(request.id, null, String(error)).catch((error) => callbacks.current.report(String(error)));
      });
    }));
    scope.add(onLifecycleRelease((released) => {
      if (transaction.current !== released) return;
      transaction.current = null;
      pending.current?.("cancel"); pending.current = null;
      setPrompt(null); setError(null); if (localRequests.current === 0) setBlocked(false);
    }));
    scope.add(onLifecycleError((error) => { setWarning(error); callbacks.current.report(error); }));
    return () => { pending.current?.("cancel"); pending.current = null; scope.dispose(); };
  }, [store]);

  const [, refresh] = useState(0);
  useEffect(() => {
    if (!prompt?.lease) return;
    return callbacks.current.activity().draft?.subscribe(() => refresh((value) => value + 1));
  }, [prompt]);

  const choose = async (choice: string) => {
    if (!prompt || busy) return;
    setBusy(true); setError(null);
    try {
      if (choice === "apply") {
        const draft = callbacks.current.activity().draft;
        if (!draft || !draft.canApply) throw new Error("Draft is invalid, stale, or still validating. Discard it or cancel this request to continue editing.");
        await draft.apply();
        choice = "applied";
      } else if (choice === "save") {
        const snapshot = prompt.snapshot!;
        const path = snapshot.path ? null : await native.dialogs.saveMarkdown("untitled.md");
        if (!snapshot.path && !path) throw new Error("Save dialog canceled. Choose Save, Discard, or Cancel.");
        const result = path ? await native.documents.saveAs(snapshot.docId, path) : await native.documents.save(snapshot.docId);
        if (!result.ok) throw new Error(result.message ?? result.reason ?? "Save failed");
        choice = "saved";
      }
      prompt.finish(choice); pending.current = null; setPrompt(null);
    } catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  };
  const begin = async (trigger: LifecycleTrigger, docIds: string[] = []) => {
    if (!isTauri()) return true;
    localRequests.current++; setBlocked(true);
    try { return await native.lifecycle.begin(trigger, docIds); }
    catch (error) { callbacks.current.report(String(error)); return false; }
    finally { localRequests.current--; if (localRequests.current === 0 && transaction.current === null) setBlocked(false); }
  };
  const draft = callbacks.current.activity().draft;
  const dialog = prompt ? <div className="overlay" role="dialog" aria-modal="true"><div className="dialog">
    <h3>{prompt.lease ? "Resolve unapplied draft" : "Resolve unsaved document"}</h3>
    <p>{prompt.request.body.displayName ?? prompt.snapshot?.path ?? (prompt.lease ? "Document draft" : "Untitled")}</p>
    <p>{prompt.request.body.trigger === "quit" ? "Quit will close all windows only after every document is resolved." : "Resolve this document before continuing."}</p>
    {prompt.snapshot && <pre aria-label="Document preview">{Array.from(prompt.snapshot.content.slice(0, 180)).slice(0, 120).join("") || "Empty document"}</pre>}
    {prompt.request.body.summary && <details><summary>Documents in this request</summary><ul>{prompt.request.body.summary.map((name, index) => <li key={index}>{name}</li>)}</ul></details>}
    {prompt.lease?.ownerWindow === null && <><p>Recovered draft has no active owner. Cancel to restore it, or explicitly discard it.</p><textarea readOnly aria-label="Recovered draft text" value={prompt.lease.text} /></>}
    {error && <p role="alert">{error}</p>}
    <div className="dialog-actions">
      {prompt.lease ? <button disabled={busy || !draft?.canApply || prompt.lease.ownerWindow === null} onClick={() => void choose("apply")}>Apply</button>
        : <button disabled={busy} onClick={() => void choose("save")}>Save</button>}
      <button disabled={busy} onClick={() => void choose("discard")}>Discard</button>
      <button disabled={busy} onClick={() => void choose("cancel")}>Cancel</button>
    </div>
  </div></div> : blocked ? <p role="status" className="lifecycle-wait">Resolving document changes. Other windows remain open until the request finishes.</p> : null;
  return { blocked, begin, dialog: <>{dialog}{warning && <aside className="lifecycle-wait" role="alert"><p>{warning}</p><button onClick={() => setWarning(null)}>Dismiss</button></aside>}</> };
}
