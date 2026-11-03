import { useEffect, useState } from "react";
import { WorkspaceSearch } from "./WorkspaceSearch";
import { native, type WorkspaceEntry } from "../../services/native";

function Directory({ path, patterns, refresh, onOpen, depth = 0 }: { path: string; patterns: string[]; refresh: number; onOpen: (path: string) => void; depth?: number }) {
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]), [error, setError] = useState<string | null>(null), [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    let alive = true;
    void native.workspace.list(path, patterns).then((rows) => { if (alive) { setEntries(rows); setError(null); } }, (error) => { if (alive) setError(String(error)); });
    return () => { alive = false; };
  }, [path, patterns, refresh]);
  return <ul className="workspace-tree">{error && <li role="alert">{error}</li>}{entries.map((entry) => <li key={entry.path}>
    <button disabled={entry.isDir && depth >= 16} aria-expanded={entry.isDir ? expanded.has(entry.path) : undefined} onClick={() => {
      if (!entry.isDir) { onOpen(entry.path); return; }
      setExpanded((previous) => { const next = new Set(previous); if (!next.delete(entry.path)) next.add(entry.path); return next; });
    }}>{entry.isDir ? expanded.has(entry.path) ? "▾ " : "▸ " : ""}{entry.name}</button>
    {entry.isDir && expanded.has(entry.path) && <Directory path={entry.path} patterns={patterns} refresh={refresh} onOpen={onOpen} depth={depth + 1} />}
  </li>)}</ul>;
}
export function WorkspaceTree({ onOpen }: { onOpen: (path: string) => void }) {
  const [root, setRoot] = useState<string | null>(null), [refresh, setRefresh] = useState(0), [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState(() => localStorage.getItem("marquellium-workspace-excludes") ?? "node_modules, target, dist");
  useEffect(() => { let active = true; void native.workspace.root().then((root) => { if (active) setRoot((current) => current ?? root); }).catch((error) => { if (active) setError(String(error)); }); return () => { active = false; }; }, []);
  const [patterns, setPatterns] = useState(() => input.split(",").map((s) => s.trim()).filter(Boolean));
  return <section aria-label="Workspace files">
    <button onClick={() => { void native.dialogs.openFolder().then((path) => { if (path) { setRoot(path); setError(null); } }).catch((error) => setError(String(error))); }}>Open folder…</button>
    {root && <><p title={root}>{root.split(/[\\/]/).pop()}</p><button onClick={() => setRefresh((n) => n + 1)}>Refresh files</button></>}
    <label>Exclude patterns <input aria-label="Workspace exclusions" value={input} onChange={(e) => setInput(e.target.value)} /></label>
    <button onClick={() => { setPatterns(input.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 100)); localStorage.setItem("marquellium-workspace-excludes", input); }}>Apply exclusions</button>
    <p className="sidebar-empty">Comma-separated * and ** exclusions. Hidden files and symlinks are omitted.</p>
    {error && <p role="alert">{error}</p>}
    {root && <WorkspaceSearch key={JSON.stringify([root, patterns])} patterns={patterns} onOpen={onOpen} />}
    {root ? <Directory path={root} patterns={patterns} refresh={refresh} onOpen={onOpen} /> : <p>Choose a folder to browse Markdown and text files.</p>}
  </section>;
}
