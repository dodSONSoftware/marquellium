/** Runs only in the disposable native helper, never in the document webview. */
import mermaid from "mermaid";
import { invoke } from "@tauri-apps/api/core";
import { checkMermaidBody } from "./policy";

async function render() {
  try {
    const source = await invoke<string>("preview_input");
    checkMermaidBody(source);
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", htmlLabels: false,
      maxTextSize: 16_384, maxEdges: 100, suppressErrorRendering: true,
      secure: ["securityLevel", "htmlLabels", "maxTextSize", "maxEdges", "startOnLoad", "theme", "fontFamily"],
      flowchart: { htmlLabels: false }, fontFamily: "sans-serif" });
    await mermaid.parse(source);
    const { svg } = await mermaid.render("diagram-preview", source);
    if (svg.length > 512 * 1024) throw new Error("diagram output limit exceeded");
    await invoke("preview_finish", { result: { svg, error: null } });
  } catch (error) {
    await invoke("preview_finish", { result: { svg: null, error: String(error).slice(0, 512) } });
  }
}
void render();
