import { subscriptionScope } from "../../services/subscription-scope";
import { useEffect, useState } from "react";
import { native, onWindowCloseRequested, onMenuCommand } from "../../services/native";
import { DocumentStore } from "../documents/DocumentStore";
import { useLifecycle } from "../documents/useLifecycle";
export function PrintPreview() {
  const [store] = useState(() => new DocumentStore());
  const [html, setHtml] = useState("");
  const [error, setError] = useState<string | null>(null);
  const lifecycle = useLifecycle(store, () => ({ draft: null, direct: null }), setError);
  useEffect(() => {
    const report = (error: unknown) => setError(String(error));
    const subscriptions = subscriptionScope(report);
    void native.export.previewContent().then(setHtml).catch(report);
    const close = () => { void native.lifecycle.begin("close-window").catch(report); };
    subscriptions.add(onWindowCloseRequested(close));
    subscriptions.add(onMenuCommand((id) => { if (id === "close_tab") close(); }));
    return () => subscriptions.dispose();
  }, []);
  return <><div inert={lifecycle.blocked}><div className="print-controls"><button onClick={() => void native.export.print().catch((e) => setError(String(e)))}>Print / Save PDF…</button><p>Choose a PDF destination in the native print dialog (PDF on macOS, Microsoft Print to PDF on Windows, or Print to File on Linux). Choose paper, margins and scaling there. Large tables/figures may span pages.</p>{error && <p role="alert">{error}</p>}</div><div className="export-document" dangerouslySetInnerHTML={{ __html: html }} /></div>{lifecycle.dialog}</>;
}
