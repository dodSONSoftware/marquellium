// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { exportDocument, standaloneHtml } from "./document";
const resources = () => ({ image: vi.fn(async () => "data:image/png;base64,iVBORw0KGgo="), mermaid: vi.fn(async () => '<svg xmlns="http://www.w3.org/2000/svg"><text>Static diagram</text></svg>') });
it("retains the binding export corpus in HTML and native DOCX blocks", async () => {
  const source = readFileSync("fixtures/export/export-fixture.md", "utf8"), api = resources();
  const result = await exportDocument(source, api), doc = new DOMParser().parseFromString(standaloneHtml('Title <script>', result.body), "text/html");
  expect(doc.querySelectorAll("h1,h2,h3,h4,h5,h6").length).toBeGreaterThan(10);
  expect(doc.querySelector("h6")?.textContent).toBe("Level six");
  expect(doc.querySelectorAll("table tr")).toHaveLength(3);
  expect(doc.querySelectorAll("math")).toHaveLength(2);
  expect(doc.querySelector('img[alt="Diagram"]')?.getAttribute("src")).toMatch(/^data:image\/png/);
  expect(doc.querySelector('img[alt="Mermaid diagram"]')?.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
  expect(doc.body.textContent).toContain("def answer() -> int:"); expect(doc.body.textContent).toContain("☐");
  expect(doc.querySelector("script,iframe,object")).toBeNull();
  const blocks = JSON.stringify(result.blocks);
  for (const text of ["Level six", "Ada", "Grace", "answer", "TeX source", "Mermaid diagram", "unchecked task", "nested", "End of export fixture"]) expect(blocks).toContain(text);
  expect(result.blocks.some((b) => b.kind === "image")).toBe(true);
  expect(result.blocks.some((b) => b.kind === "paragraph" && b.runs.some((r) => r.href === "https://example.com"))).toBe(true);
});
it("escapes raw syntax and blocked links, retaining failed preview and image sources visibly", async () => {
  const api = { image: vi.fn(async () => { throw new Error("outside scope"); }), mermaid: vi.fn(async () => { throw new Error("invalid syntax"); }) };
  const source = '<script>alert(1)</script>\n\n[x](javascript:alert(1)) ![missing](secret.png)\n\n```mermaid\nbad diagram\n```\n\n$$\n\\frac{\n$$\n';
  const result = await exportDocument(source, api), doc = new DOMParser().parseFromString(standaloneHtml("Hostile", result.body), "text/html");
  expect(doc.querySelector("script")).toBeNull(); expect(doc.querySelector('[href^="javascript:"]')).toBeNull();
  for (const text of ["<script>", "secret.png", "bad diagram", "\\frac{"]) expect(doc.body.textContent).toContain(text);
  expect(result.warnings.length).toBeGreaterThanOrEqual(3);
});
it("preserves ordered lists, tasks, reference links, source metadata and block order", async () => {
  const result = await exportDocument('---\ntitle: Keep\n---\n\n3. one\n4. two\n\n- [x] done\n\n> quote **bold**\n\n[ref][r]\n\n[r]: https://example.com\n', resources());
  expect(result.body).toContain('<ol start="3">');
  const text = result.blocks.filter((b) => b.kind === "paragraph").flatMap((b) => b.runs.map((r) => r.text)).join("");
  expect(text).toContain("title: Keep"); expect(text).toContain("3. one4. two• ☑ done");
  expect(text.indexOf("one")).toBeLessThan(text.indexOf("quote"));
});
