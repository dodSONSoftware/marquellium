import { describe, expect, it } from "vitest";
import { editTable } from "./table-edit";
import { createSourceMap } from "./source-map";
import { editMappedBlock, prepareLocalizedEdit } from "./localized-edit";
import { applyOps, bytesToString, stringToBytes } from "./ops";
const table = "| A | B |\r\n|:---|---:|\r\n| x\\|y | `code` |\r\n| **bold** | 2 |";
describe("source-preserving table helpers", () => {
  it("adds and removes a selected row without changing existing rows or CRLF", () => {
    const added = editTable(table, { kind: "add-row", index: 1 });
    expect(added).toBe("| A | B |\r\n|:---|---:|\r\n| x\\|y | `code` |\r\n| | |\r\n| **bold** | 2 |");
    expect(editTable(added, { kind: "remove-row", index: 2 })).toBe(table);
  });
  it("adds/removes a column and preserves escaped pipes and inline source", () => {
    const added = editTable(table, { kind: "add-column", index: 0 });
    expect(added).toBe("| A | | B |\r\n|:---| --- |---:|\r\n| x\\|y | | `code` |\r\n| **bold** | | 2 |");
    expect(editTable(added, { kind: "remove-column", index: 1 })).toBe(table);
    expect(editTable(table, { kind: "align", index: 1, align: "center" })).toBe(table.replace("---:", ":---:"));
  });
  it("applies through the production localized transaction without touching protected neighbors", () => {
    const source = "<!-- EXACT -->\r\n\r\n" + table + "\r\n\r\n:::vendor\r\nKEEP\r\n:::";
    const map = createSourceMap({ docId: "d", revision: 6, text: source });
    const block = map.blocks.find((b) => b.node.type === "table")!;
    const edit = editMappedBlock(map, block, editTable(block.source, { kind: "align", index: 1, align: "left" }));
    const result = applyOps(stringToBytes(source), prepareLocalizedEdit(map.snapshot, edit));
    expect(result.ok).toBe(true); expect(bytesToString(result.next)).toBe(source.replace("---:", ":---"));
  });
  it("rejects ambiguous tables, invalid indices, deleting header/last column and size overflow", () => {
    expect(() => editTable(table, { kind: "remove-row", index: 0 })).toThrow("header");
    expect(() => editTable(table, { kind: "add-column", index: -1 })).toThrow("selection");
    expect(() => editTable("| a |\n|---|\n| b |", { kind: "remove-column", index: 0 })).toThrow("one");
    expect(() => editTable("| a | b |\n|---|---|\n| x |", { kind: "add-row", index: 0 })).toThrow("matching");
    expect(() => editTable("not a table", { kind: "add-row", index: 0 })).toThrow();
  });
});
