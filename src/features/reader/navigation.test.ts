// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { readerContext, restoreReaderContext } from "./navigation";

describe("Reader source navigation", () => {
  it("captures the visible block rather than the prior editor selection", () => {
    const root = document.createElement("div");
    root.innerHTML = '<h1 data-source-start="0">Title</h1><p data-source-start="9">Second</p>';
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue({ top: 100 } as DOMRect);
    vi.spyOn(root.children[0]!, "getBoundingClientRect").mockReturnValue({ bottom: 80 } as DOMRect);
    vi.spyOn(root.children[1]!, "getBoundingClientRect").mockReturnValue({ bottom: 130 } as DOMRect);
    const text = "# Title\n\nSecond";
    expect(readerContext(root, text)).toEqual({ text, anchor: 9, head: 9 });
  });

  it("restores through source edits and ignores invalid DOM offsets", () => {
    const root = document.createElement("div");
    root.innerHTML = '<p data-source-start="NaN"></p><p data-source-start="0"></p><p data-source-start="12"></p><p data-source-start="999"></p>';
    const scroll = vi.fn();
    root.children[2]!.scrollIntoView = scroll;
    restoreReaderContext(root, { text: "one\n\ntarget", anchor: 5, head: 11 }, "longer text\n\ntarget");
    expect(scroll).toHaveBeenCalledWith({ block: "center" });
  });

  it("uses a grapheme boundary and safely handles a document without anchors", () => {
    const root = document.createElement("div");
    expect(readerContext(root, "")).toBeNull();
    expect(() => restoreReaderContext(root, { text: "", anchor: 0, head: 0 }, "")).not.toThrow();
    root.innerHTML = '<p data-source-start="1"></p>';
    vi.spyOn(root.children[0]!, "getBoundingClientRect").mockReturnValue({ bottom: 10 } as DOMRect);
    expect(readerContext(root, "😀")).toEqual({ text: "😀", anchor: 0, head: 0 });
  });
});

it("maps source block position across unequal pane heights", async () => {
  const { scrollReaderOffset } = await import("./navigation");
  const root = document.createElement("div");
  root.innerHTML = '<p data-source-start="0"></p><p data-source-start="40"></p><pre data-source-start="90"></pre>';
  root.scrollTop = 20;
  vi.spyOn(root, "getBoundingClientRect").mockReturnValue({ top: 100 } as DOMRect);
  vi.spyOn(root.children[1]!, "getBoundingClientRect").mockReturnValue({ top: 350 } as DOMRect);
  scrollReaderOffset(root, 65, 100);
  expect(root.scrollTop).toBe(270);
});

it("real Reader headings, paragraphs, math and code retain navigable raw source offsets", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { Reader } = await import("./Reader");
  const source = "# Heading\n\nParagraph.\n\n$$\nx^2\n$$\n\n```rust\nlet x = 1;\n```";
  const root = document.createElement("div");
  root.innerHTML = renderToStaticMarkup(createElement(Reader, { content: source, docPath: null, onOpenLocal: () => {}, onOpenExternal: () => {} }));
  const offsets = [...root.querySelectorAll<HTMLElement>("[data-source-start]")].map((node) => Number(node.dataset.sourceStart));
  for (const marker of ["# Heading", "Paragraph.", "$$", "```rust"]) expect(offsets).toContain(source.indexOf(marker));
  expect(offsets.every(Number.isFinite)).toBe(true);
});

it("syncing Source to frontmatter before the first rendered anchor returns Reader to the top", async () => {
  const { scrollReaderOffset } = await import("./navigation");
  const root = document.createElement("div"); root.innerHTML = '<h1 data-source-start="50">Heading</h1>'; root.scrollTop = 500;
  scrollReaderOffset(root, 0, 100); expect(root.scrollTop).toBe(0);
});

it("converts zoomed document coordinates to logical scroll offsets", async () => {
  const { scrollReaderOffset } = await import("./navigation");
  const root = document.createElement("div"); root.innerHTML = '<p data-source-start="0"></p><p data-source-start="40"></p>';
  root.scrollTop = 20;
  Object.defineProperty(root, "offsetHeight", { value: 200 });
  vi.spyOn(root, "getBoundingClientRect").mockReturnValue({ top: 100, height: 300 } as DOMRect);
  vi.spyOn(root.children[1]!, "getBoundingClientRect").mockReturnValue({ top: 400 } as DOMRect);
  scrollReaderOffset(root, 65, 100); expect(root.scrollTop).toBe(220);
});
