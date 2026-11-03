import { useState } from "react";
import { editTable, type TableAction } from "../../core/table-edit";
import type { MappedBlock } from "../../core/source-map";

export function TableTools({ block, disabled, onEdit }: { block: MappedBlock; disabled: boolean; onEdit: (source: string) => void }) {
  const [row, setRow] = useState(0), [column, setColumn] = useState(0), [error, setError] = useState<string | null>(null);
  const rows = block.node.children.length, columns = block.node.children[0]?.children.length ?? 0;
  const selectedRow = Math.min(row, rows - 1), selectedColumn = Math.min(column, columns - 1);
  const run = (action: TableAction) => {
    try { const source = editTable(block.source, action); setError(null); onEdit(source); }
    catch (error) { setError(String(error)); }
  };
  return <fieldset disabled={disabled} className="table-tools"><legend>Table helpers</legend>
    <label>Row <select aria-label="Table row" value={selectedRow} onChange={(e) => setRow(Number(e.target.value))}>{Array.from({ length: rows }, (_, i) => <option key={i} value={i}>{i === 0 ? "Header" : i}</option>)}</select></label>
    <button onClick={() => run({ kind: "add-row", index: selectedRow })}>Add row</button>
    <button disabled={selectedRow === 0} onClick={() => run({ kind: "remove-row", index: selectedRow })}>Remove row</button>
    <label>Column <select aria-label="Table column" value={selectedColumn} onChange={(e) => setColumn(Number(e.target.value))}>{Array.from({ length: columns }, (_, i) => <option key={i} value={i}>{i + 1}</option>)}</select></label>
    <button onClick={() => run({ kind: "add-column", index: selectedColumn })}>Add column</button>
    <button disabled={columns === 1} onClick={() => run({ kind: "remove-column", index: selectedColumn })}>Remove column</button>
    {(["left", "center", "right"] as const).map((align) => <button key={align} onClick={() => run({ kind: "align", index: selectedColumn, align })}>Align {align}</button>)}
    {error && <p role="alert">{error}</p>}
  </fieldset>;
}
