import { useState } from "react";
import { native } from "../../services/native";
import { renderMermaid } from "../visual/preview/controller";
import { exportCss, exportDocument, standaloneHtml } from "./document";
import { Modal } from "../settings/Modal";
export function ExportDialog({ docId, title, snapshot, onClose, suspended }: { docId: string; title: string; snapshot: () => Promise<string>; onClose: () => void; suspended?: boolean }) {
  const [busy, setBusy] = useState(false), [status, setStatus] = useState("");
  const run = async (format: "html" | "pdf" | "docx") => {
    if (busy) return; setBusy(true); setStatus("Preparing export…");
    try {
      const source = await snapshot();
      const result = await exportDocument(source, { image: (href) => native.export.image(docId, href), mermaid: (source) => renderMermaid(source, new AbortController().signal) });
      if (format === "pdf") { await native.export.preview(`<style>${exportCss}</style>${result.body}`); setStatus("Print preview opened. Use Print / Save PDF there."); }
      else { const path = await native.export.save(docId, format, standaloneHtml(title, result.body), result.blocks); setStatus(path ? `Exported to ${path}` : "Export canceled; no file written."); }
      if (result.warnings.length) setStatus((s) => s + "\n" + result.warnings.join("\n"));
    } catch (error) { setStatus(String(error)); }
    finally { setBusy(false); }
  };
  return <Modal suspended={suspended} title="Export document" onClose={busy ? undefined : onClose}><p>Exports use applied document content. Resolve pending drafts first. Source files are unchanged.</p><p>HTML is self-contained with raster images and static diagrams. PDF uses the native print dialog. DOCX preserves text, headings, links, lists and tables; math/Mermaid use visible source fallbacks. PNG images embed; other images retain a visible source/alt fallback. Unsupported syntax remains visible source. List numbering is preserved as text.</p><div>{(["html", "pdf", "docx"] as const).map((format) => <button key={format} disabled={busy} onClick={() => void run(format)}>Export {format.toUpperCase()}</button>)}</div><p role="status" style={{ whiteSpace: "pre-wrap" }}>{status}</p></Modal>;
}
