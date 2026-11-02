/** Draft-only CM surface. It is not enabled in App until the Visual integration. */
import { useEffect, useReducer, useRef } from "react";
import { EditorView } from "@codemirror/view";
import type { DraftSession } from "../../core/draft-session";

export function InlineSourceEditor({ session, onClosed }: { session: DraftSession; onClosed?: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    if (!host.current || session.closed) return;
    const view = new EditorView({
      parent: host.current,
      state: session.state,
      dispatchTransactions: (transactions) => {
        if (!session.busy) for (const transaction of transactions) session.dispatch(transaction);
      },
    });
    let destroyed = false;
    const unsubscribe = session.subscribe((transaction) => {
      if (session.closed && !destroyed) { view.destroy(); destroyed = true; }
      else if (transaction && !destroyed) view.update([transaction]);
      refresh();
    });
    return () => { unsubscribe(); if (!destroyed) view.destroy(); };
  }, [session]);

  const finish = async (action: "apply" | "cancel") => {
    try { await session[action](); if (session.closed) onClosed?.(); }
    catch { refresh(); } // The session retains text/history and exposes the error below.
  };
  if (session.closed) return null;
  return (
    <section aria-label="Inline source draft">
      <div ref={host} inert={session.busy} aria-label="Draft Markdown" />
      {session.isStale && <p role="alert">Document changed. Copy this draft and reopen, or Cancel.</p>}
      {session.error && <div role="alert">
        <p>{session.error}</p>
        {session.canRetry && <button onClick={() => session.retryValidation()}>Retry</button>}
      </div>}
      <ul aria-label="Draft diagnostics">{session.validation.diagnostics.map((message, index) => <li key={index}>{message}</li>)}</ul>
      {!session.error && !session.validation.valid && session.validation.diagnostics[0] !== "Validation pending" && session.canRetry && <button onClick={() => session.retryValidation()}>Retry preview</button>}
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button disabled={session.busy} onClick={() => session.revert()}>Revert</button>
        <span style={{ flex: 1 }} />
        <button disabled={session.busy} onClick={() => void finish("cancel")}>Cancel</button>
        <button disabled={!session.canApply} onClick={() => void finish("apply")}>Apply</button>
      </div>
    </section>
  );
}
