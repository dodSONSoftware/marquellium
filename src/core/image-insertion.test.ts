import { expect, it } from "vitest";
import { imageInsertion } from "./image-insertion";
import { prepareLocalizedEdit } from "./localized-edit";
import { applyOps, bytesToString, stringToBytes } from "./ops";
import { createSourceMap } from "./source-map";
it("preserves adjacent display math/fences and CRLF on image insertion", () => {
  const text = "$$\r\nx^2\r\n$$\r\n\r\n```text\r\nKEEP\r\n```";
  const snapshot = { docId: "d", revision: 5, text };
  const edit = imageInsertion(snapshot, { text, anchor: 0, head: 0 }, "my%20assets/image.png");
  const result = applyOps(stringToBytes(text), prepareLocalizedEdit(snapshot, edit));
  expect(result.ok).toBe(true);
  const next = bytesToString(result.next);
  expect(next).toBe(text.replace("$$\r\n\r\n```text", () => "$$\r\n\r\n![Pasted image](my%20assets/image.png)\r\n\r\n\r\n\r\n```text"));
  expect(createSourceMap({ ...snapshot, text: next }).blocks.map((b) => b.node.type)).toEqual(["math", "paragraph", "code"]);
  expect(() => prepareLocalizedEdit({ ...snapshot, revision: 6 }, edit)).toThrow("stale");
  for (const path of ["../secret", "javascript:alert(1)", "x)bad", "/tmp/a.png"]) expect(() => imageInsertion(snapshot, undefined, path)).toThrow("Unsafe");
});

it("inserts images inline in an empty table cell without breaking its row", () => {
  const text = "| A | B |\n|---|---|\n| x | |";
  const position = text.lastIndexOf("|");
  const snapshot = { docId: "d", revision: 0, text };
  const edit = imageInsertion(snapshot, { text, anchor: position, head: position }, "assets/image.png");
  const result = applyOps(stringToBytes(text), prepareLocalizedEdit(snapshot, edit));
  expect(bytesToString(result.next)).toBe(text.slice(0, position) + "![Pasted image](assets/image.png)" + text.slice(position));
  expect(createSourceMap({ ...snapshot, text: bytesToString(result.next) }).blocks.map((b) => b.node.type)).toEqual(["table"]);
});
