import { expect, it } from "vitest";
import { localLinks, hasAnchor } from "./local-links";
it("discovers local references and images without returning network or executable URLs", () => {
  const source = "# 東京\n# Same\n# Same\n[one](other%20file.md#hello) ![x](assets/pic.png) [anchor](#same-1) [ref][id]\n\n[id]: notes.md\n\n[remote](https://example.com) ![tracking](https://evil.invalid/a) [bad](javascript:alert)";
  expect(localLinks(source)).toEqual(["other%20file.md#hello", "assets/pic.png", "#same-1", "notes.md"]);
  expect(hasAnchor(source, "same-1")).toBe(true); expect(hasAnchor(source, "東京")).toBe(true); expect(hasAnchor(source, "missing")).toBe(false);
});
it("does not interpret YAML metadata as a heading or invent anchor IDs", () => {
  const source = "---\ntitle: False heading\n---\n\n# Actual heading\n";
  expect(hasAnchor(source,"title-false-heading")).toBe(false);
  expect(hasAnchor(source,"actual-heading")).toBe(true);
});
