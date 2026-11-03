import { expect, it } from "vitest";
import { renderMath } from "./math";
it("renders inline/display KaTeX and bounds invalid input", () => {
  expect(renderMath("x^2")).toContain('class="katex"'); expect(renderMath("\\frac{a}{b}", true)).toContain("katex-display");
  expect(() => renderMath("\\frac{")).toThrow(); expect(() => renderMath("x".repeat(16385))).toThrow("16 KiB");
  expect(() => renderMath("\\def\\a{\\a}\\a")).toThrow();
});
it("untrusted math cannot supply active links, external images or HTML", () => {
  for (const source of ["\\href{javascript:alert(1)}{click}", "\\includegraphics{https://evil.invalid/x}", "\\htmlStyle{background:url(https://evil.invalid/x)}{x}"]) {
    let html = ""; try { html = renderMath(source); } catch { /* strict unsupported commands are an acceptable inert fallback */ }
    expect(html).not.toMatch(/<(?:a|img|script)\b/i); expect(html).not.toMatch(/(?:href|src)=["'](?:javascript|https):/i);
  }
});
