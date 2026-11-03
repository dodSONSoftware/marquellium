import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createSourceMap, type MappedNode } from "../../core/source-map";
import { DirectTextController, directTextEdit } from "./direct-edit";
import { checkMermaidBody, mermaidBody, validateSourcePreview, validateTable } from "./preview/policy";
import { PreviewController } from "./preview/controller";
import { prepareLocalizedEdit, type LocalizedEdit } from "../../core/localized-edit";
import { applyOps, bytesToString, stringToBytes } from "../../core/ops";

function leaves(node: MappedNode): MappedNode[] { return node.type === "text" ? [node] : node.children.flatMap(leaves); }
function target(text: string, selected: string) {
  const map = createSourceMap({ docId: "doc", revision: 0, text });
  const leaf = map.blocks.flatMap((block) => leaves(block.node)).find((node) => node.decodedText === selected);
  if (!leaf) throw new Error("test leaf missing");
  return { map, leaf };
}

describe("direct visual text adapter", () => {
  it.each([
    ["Before **bold** and [link](target).\r\n\r\n<!-- KEEP -->", "bold", "bolder", "Before **bolder** and [link](target).\r\n\r\n<!-- KEEP -->"],
    ["Plain text.", "Plain text.", "Plain *literal* text.", "Plain \\*literal\\* text."],
    ["| a | b |\r\n|:---|---:|\r\n| a\\|b | plain |", "plain", "x|y", "| a | b |\r\n|:---|---:|\r\n| a\\|b | x\\|y |"],
    ["Emoji 🎉.", "Emoji 🎉.", "Emoji 🎊.", "Emoji 🎊."],
  ])("preserves unrelated source and literal spelling: %s", (source, original, replacement, expected) => {
    const { map, leaf } = target(source, original);
    const prepared = directTextEdit(map, leaf, replacement);
    expect(prepared.expected).toBe(expected);
    expect(prepared.nextLeaf.decodedText).toBe(replacement);
  });
  it("can continue editing escaped text without double escaping", () => {
    const { map, leaf } = target("Literal \\*star\\*.", "Literal *star*.");
    expect(directTextEdit(map, leaf, "Literal *stars*.").expected).toBe("Literal \\*stars\\*.");
  });
  it.each(["", "line\rbreak", "x".repeat(16385)])("rejects unsupported direct text without mutation", (replacement) => {
    const { map, leaf } = target("word", "word");
    expect(() => directTextEdit(map, leaf, replacement)).toThrow();
    expect(map.snapshot.text).toBe("word");
  });
  it("refuses structural changes and entity-normalized source", () => {
    const a = target("**bold**", "bold");
    expect(() => directTextEdit(a.map, a.leaf, " bold")).toThrow("structure");
    const b = target("Entity &amp; value", "Entity & value");
    expect(() => directTextEdit(b.map, b.leaf, "new")).toThrow("source editor");
  });
  it("serializes fast input through acknowledged maps", async () => {
    const { map, leaf } = target("base", "base");
    let snapshot = map.snapshot;
    let finish!: () => void;
    const apply = vi.fn(async (edit: LocalizedEdit) => {
      if (apply.mock.calls.length === 1) await new Promise<void>((resolve) => { finish = resolve; });
      const result = applyOps(stringToBytes(snapshot.text), prepareLocalizedEdit(snapshot, edit));
      if (!result.ok) throw new Error("invalid test operation");
      snapshot = { ...snapshot, revision: snapshot.revision + 1, text: bytesToString(result.next) };
    });
    const controller = new DirectTextController(map, leaf, { applyLocalizedEdit: apply, captureSourceSnapshot: async () => snapshot });
    controller.input("first");
    controller.input("latest");
    finish();
    await controller.settle();
    expect(snapshot.text).toBe("latest");
    expect(controller.hasPending).toBe(false);
    expect(apply).toHaveBeenCalledTimes(2);
  });
  it("retains desired text on a lost race and never retries against a foreign revision", async () => {
    const { map, leaf } = target("base", "base");
    const apply = vi.fn(async () => { throw new Error("stale revision"); });
    const controller = new DirectTextController(map, leaf, { applyLocalizedEdit: apply, captureSourceSnapshot: async () => map.snapshot });
    controller.input("do not lose this");
    await controller.settle();
    expect(controller.display).toBe("do not lose this");
    expect(controller.hasPending).toBe(true);
    expect(controller.error).toContain("retained");
    expect(apply).toHaveBeenCalledOnce();
    controller.input("another attempt");
    await controller.settle();
    expect(apply).toHaveBeenCalledOnce();
    expect(controller.display).toBe("another attempt");
    expect(controller.error).toContain("stale revision");
  });
});

describe("preview grammar and resource policy", () => {
  it.each(["flowchart LR\nA-->B", "sequenceDiagram\nA->>B: hello\nB-->>A: done", "classDiagram\nA --> B"])("allows representative supported diagrams", (body) => {
    expect(() => checkMermaidBody(body)).not.toThrow();
    expect(mermaidBody(`~~~~mermaid title\r\n${body}\r\n~~~~`)).toBe(body);
  });
  it.each(["flowchart LR\nclick A callback", "flowchart LR\n%%{init: {}}%%", "flowchart LR\nA[<img src=x>]", "flowchart LR\nA@{img: 'x'}", "flowchart LR\nstyle A fill:red", "flowchart LR\nA[https://evil.test]", "pie\n\"x\":1"])("blocks unsafe or unsupported preview features: %s", (body) => {
    expect(() => checkMermaidBody(body)).toThrow();
  });
  it("requires a closed single Mermaid fence and bounded input", () => {
    for (const source of ["```mermaid\nflowchart LR\nA-->B", "```mermaid\nflowchart LR\n```\nparagraph\n```", `\`\`\`mermaid\nflowchart LR\n${"A".repeat(17000)}\n\`\`\``]) expect(() => mermaidBody(source)).toThrow();
  });
  it("validates a single GFM table, including escaped pipes and inline code", () => {
    expect(() => validateTable("| a | b |\r\n|:---|---:|\r\n| a\\|b | `code` |")).not.toThrow();
    for (const source of ["| a | b |\nnot delimiter", "| a | b |\n|---|---|\n|one|", "| a |\n|---|\n\nOutside"]) expect(() => validateTable(source)).toThrow();
  });
  it("bounds explicit protected-source previews before rendering", () => {
    expect(() => validateSourcePreview("<!-- unknown source -->")).not.toThrow();
    expect(() => validateSourcePreview("x".repeat(17000))).toThrow("limit");
    expect(() => validateSourcePreview("> ".repeat(40) + "deep")).toThrow("budget");
  });

  it("keeps the helper outside privileged window capability patterns", () => {
    const main = JSON.parse(readFileSync(new URL("../../../src-tauri/capabilities/default.json", import.meta.url), "utf8")) as { windows: string[] };
    for (const pattern of main.windows) {
      const regex = new RegExp("^" + pattern.replace(/[-/\\^$+?.()|[\]{}]/g, "\\$&").replace(/\*/g, ".*") + "$");
      expect(regex.test("preview-worker")).toBe(false);
    }
    const helper = JSON.parse(readFileSync(new URL("../../../src-tauri/capabilities/preview.json", import.meta.url), "utf8")) as { permissions: unknown[] };
    expect(helper.permissions).toEqual([]);
  });

  it("retains last valid preview and ignores late results after replacement/disposal", async () => {
    let first!: (svg: string) => void;
    let signal: AbortSignal | undefined;
    const render = vi.fn(async (_source: string, abort: AbortSignal) => {
      if (render.mock.calls.length === 1) { signal = abort; return new Promise<string>((resolve) => { first = resolve; }); }
      return "<svg>new</svg>";
    });
    const controller = new PreviewController("mermaid", render);
    const old = controller.validate("```mermaid\nflowchart LR\nA-->B\n```");
    await controller.validate("```mermaid\nflowchart LR\nA-->C\n```");
    expect(signal?.aborted).toBe(true);
    first("<svg>old</svg>");
    await old;
    expect(controller.lastValid?.svg).toBe("<svg>new</svg>");
    expect((await controller.validate("INVALID")).valid).toBe(false);
    expect(controller.lastValid?.svg).toBe("<svg>new</svg>");
    controller.dispose();
    expect((await controller.validate("```mermaid\nflowchart LR\nA-->B\n```")).valid).toBe(false);
  });
});


describe("Visual adapter independent byte fixtures", () => {
  it.each([["direct", "bold", "bolder"], ["table", "plain", "x|y"]])("%s", (fixture, selected, display) => {
    const bytes = readFileSync(new URL(`../../../fixtures/markdown/m3v/${fixture}-input.md`, import.meta.url));
    const bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
    const source = new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(bom ? 3 : 0));
    const { map, leaf } = target(source, selected);
    const result = directTextEdit(map, leaf, display);
    const saved = Buffer.concat([bytes.subarray(0, bom ? 3 : 0), Buffer.from(result.expected)]);
    expect(saved).toEqual(readFileSync(new URL(`../../../fixtures/markdown/m3v/${fixture}-expected.md`, import.meta.url)));
  });
});

describe("M4 supported containers and soft lines", () => {
  it.each([
    ["- outer **bold**\n  - nested text\n\n<!-- KEEP -->", "nested text", "nested edit", "- outer **bold**\n  - nested edit\n\n<!-- KEEP -->"],
    ["> Quoted **bold**.\n\n<!-- KEEP -->", "bold", "changed", "> Quoted **changed**.\n\n<!-- KEEP -->"],
    ["First soft line\r\nSecond soft line\r\n\r\n<!-- KEEP -->", "First soft line\r\nSecond soft line", "First soft line\nChanged line", "First soft line\r\nChanged line\r\n\r\n<!-- KEEP -->"],
    ["[Label][id]\n\n[id]: relative.md", "Label", "Changed", "[Changed][id]\n\n[id]: relative.md"],
  ])("edits leaves without rewriting container delimiters: %s", (source, selected, display, expected) => {
    const { map, leaf } = target(source, selected);
    expect(directTextEdit(map, leaf, display).expected).toBe(expected);
  });
  it("accepts a soft line and longer text while rejecting a paragraph split", () => {
    const { map, leaf } = target("word", "word");
    expect(directTextEdit(map, leaf, "soft\nline").expected).toBe("soft\nline");
    expect(directTextEdit(map, leaf, "x".repeat(2049)).expected).toBe("x".repeat(2049));
    expect(() => directTextEdit(map, leaf, "a\n\nb")).toThrow("structure");
  });
  it("validates math drafts, retaining the last valid preview on malformed math", async () => {
    const preview = new PreviewController("math");
    expect((await preview.validate("$$\nx^2\n$$")).valid).toBe(true);
    expect((await preview.validate("$$\n\\frac{\n$$")).valid).toBe(false);
    expect(preview.lastValid?.source).toBe("$$\nx^2\n$$");
    expect((await preview.validate("ordinary paragraph")).valid).toBe(false);
    expect((await preview.validate("$$\nx^2")).valid).toBe(false);
    expect((await preview.validate("$$\nx^2\n$$\n\n# Outside")).valid).toBe(false);
    expect((await preview.validate("$$$$\nx^2\n$$")).valid).toBe(false);
    preview.dispose();
  });
});
