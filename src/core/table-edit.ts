import { createSourceMap } from "./source-map";

export type TableAction = { kind: "add-row" | "remove-row"; index: number } |
  { kind: "add-column" | "remove-column"; index: number } |
  { kind: "align"; index: number; align: "left" | "center" | "right" };

/** Split only unescaped GFM pipes. Backticks do not protect pipes in GFM cells. */
function cells(line: string): { values: string[]; leading: string; trailing: string } {
  const cuts: number[] = [];
  for (let i = 0; i < line.length; i++) if (line[i] === "|") {
    let escapes = 0;
    for (let j = i - 1; j >= 0 && line[j] === "\\"; j--) escapes++;
    if (escapes % 2 === 0) cuts.push(i);
  }
  const starts = [0, ...cuts.map((i) => i + 1)], ends = [...cuts, line.length];
  const values = starts.map((start, i) => line.slice(start, ends[i]));
  const leading = values[0]?.trim() === "" && cuts.length ? values.shift()! + "|" : "";
  const trailing = values.at(-1)?.trim() === "" && cuts.length ? "|" + values.pop()! : "";
  return { values, leading, trailing };
}

/** Edits one table, retaining all untouched cell spellings and line endings. */
export function editTable(source: string, action: TableAction): string {
  const map = createSourceMap({ docId: "table", revision: 0, text: source });
  const block = map.blocks[0];
  if (map.blocks.length !== 1 || block?.node.type !== "table") throw new Error("Select one GFM table");
  const lines = source.split(/\r\n|\r|\n/);
  const endings = source.match(/\r\n|\r|\n/g) ?? [];
  const count = block.node.children[0]?.children.length ?? 0;
  if (count > 20 || lines.length > 100 || lines.some((line) => cells(line).values.length !== count)) throw new Error("Table must have matching cells (at most 100 rows and 20 columns)");
  const { index } = action;
  if (!Number.isSafeInteger(index) || index < 0 || index >= (action.kind.endsWith("row") ? lines.length - 1 : count)) throw new Error("Invalid table selection");
  const ending = endings[0] ?? "\n";
  if (action.kind === "add-row") {
    if (lines.length >= 100) throw new Error("Table row limit reached");
    const at = index === 0 ? 2 : index + 2;
    lines.splice(at, 0, `|${Array.from({ length: count }, () => " ").join("|")}|`);
    endings.splice(Math.max(0, at - 1), 0, ending);
  } else if (action.kind === "remove-row") {
    if (index === 0) throw new Error("The header row cannot be removed");
    lines.splice(index + 1, 1);
    endings.splice(index, 1);
  } else {
    if (action.kind === "remove-column" && count <= 1) throw new Error("Keep at least one table column");
    if (action.kind === "add-column" && count >= 20) throw new Error("Table column limit reached");
    for (let row = 0; row < lines.length; row++) {
      const parts = cells(lines[row]!);
      if (action.kind === "add-column") parts.values.splice(index + 1, 0, row === 1 ? " --- " : " ");
      else if (action.kind === "remove-column") parts.values.splice(index, 1);
      else if (action.kind === "align" && row === 1) {
        const value = parts.values[index]!;
        const dash = value.trim().replace(/^:|:$/g, "");
        parts.values[index] = value.replace(value.trim(), `${action.align !== "right" ? ":" : ""}${dash}${action.align !== "left" ? ":" : ""}`);
      }
      lines[row] = parts.leading + parts.values.join("|") + parts.trailing;
    }
  }
  const result = lines.map((line, i) => line + (endings[i] ?? "")).join("");
  const next = createSourceMap({ docId: "table", revision: 0, text: result });
  if (next.blocks.length !== 1 || next.blocks[0]?.node.type !== "table") throw new Error("Table helper produced invalid Markdown");
  return result;
}

export const newTable = "| Column 1 | Column 2 |\n| --- | --- |\n|  |  |";
