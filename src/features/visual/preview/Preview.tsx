import { useEffect, useState } from "react";
import { Reader, type ReaderProps } from "../../reader/Reader";
import type { PreviewResult } from "./controller";

/** Engine SVG is an inert image payload; it never enters the app DOM as HTML. */
export function DiagramImage({ svg }: { svg: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const objectUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [svg]);
  return url ? <img className="diagram-preview" src={url} alt="Mermaid diagram preview" /> : <p>Preparing diagram…</p>;
}
export function DraftPreview({ preview, ...reader }: { preview: PreviewResult | null } & Omit<ReaderProps, "content">) {
  if (!preview) return <p>No valid preview yet.</p>;
  return preview.svg ? <DiagramImage svg={preview.svg} /> : <Reader {...reader} content={preview.source} />;
}
