import { useEffect, useRef, useState } from "react";
export interface PaletteCommand { id: string; label: string; run: () => void; disabled?: boolean }
export function CommandPalette({ commands, onClose }: { commands: PaletteCommand[]; onClose: () => void }) {
  const [query, setQuery] = useState(""), [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const matches = commands.filter((command) => !command.disabled && query.toLowerCase().split(/\s+/).every((part) => command.label.toLowerCase().includes(part)));
  const index = Math.min(selected, Math.max(0, matches.length - 1));
  useEffect(() => { const previous = document.activeElement; input.current?.focus(); return () => { if (previous instanceof HTMLElement) previous.focus(); }; }, []);
  useEffect(() => { const command = matches[index]; if (command) document.getElementById(`command-${command.id}`)?.scrollIntoView?.({ block: "nearest" }); }, [index, query]);
  const run = (command: PaletteCommand) => { onClose(); command.run(); };
  return <div className="modal-backdrop"><section role="dialog" aria-modal="true" aria-label="Command palette" className="modal" onKeyDown={(e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setSelected(matches.length ? (index + (e.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length : 0); }
    if (e.key === "Enter" && matches[index]) { e.preventDefault(); run(matches[index]!); }
    if (e.key === "Tab") { e.preventDefault(); input.current?.focus(); }
  }}><label>Find a command <input ref={input} aria-label="Find a command" aria-controls="palette-options" aria-activedescendant={matches[index] ? `command-${matches[index]!.id}` : undefined} value={query} onChange={(e) => { setQuery(e.target.value); setSelected(0); }} /></label>
    <div role="listbox" id="palette-options">{matches.map((command, i) => <button role="option" aria-selected={i === index} id={`command-${command.id}`} key={command.id} onClick={() => run(command)}>{command.label}</button>)}</div>
    {!matches.length && <p>No matching commands.</p>}<button onClick={onClose}>Close palette</button>
  </section></div>;
}
