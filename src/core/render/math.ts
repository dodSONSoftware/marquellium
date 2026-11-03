import katex from "katex";

/** No document-supplied trust, macros, HTML, styles or external resources. */
export function renderMath(source: string, displayMode = false, mathmlOnly = false): string {
  if (source.length > 16_384) throw new Error("Math input exceeds 16 KiB");
  return katex.renderToString(source, { displayMode, trust: false, strict: "error", throwOnError: true, maxExpand: 100, maxSize: 20, output: mathmlOnly ? "mathml" : "htmlAndMathml" });
}
