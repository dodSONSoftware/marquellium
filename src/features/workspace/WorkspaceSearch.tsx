import { useEffect, useRef, useState } from "react";
import { native, type WorkspaceSearchResults } from "../../services/native";

/** Remounted when the picker scope or exclusions change; late results are ignored. */
export function WorkspaceSearch({ patterns, onOpen }: { patterns: string[]; onOpen: (path: string) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WorkspaceSearchResults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  return <section aria-label="Workspace search">
    <form onSubmit={(event) => {
      event.preventDefault();
      if (busy || !query.trim()) return;
      setBusy(true); setResults(null); setError(null);
      void native.workspace.search(query, patterns).then((results) => {
        if (active.current) setResults(results);
      }, (error) => { if (active.current) setError(String(error)); }).finally(() => { if (active.current) setBusy(false); });
    }}>
      <label>Search workspace <input value={query} maxLength={256} disabled={busy} onChange={(e) => { setQuery(e.target.value); setResults(null); }} /></label>
      <button disabled={busy || !query.trim()}>{busy ? "Searching…" : "Search files"}</button>
    </form>
    <p className="sidebar-empty">Literal, case-sensitive search of saved Markdown/text files. Unsaved edits are not searched.</p>
    {error && <p role="alert">{error}</p>}
    {results && <><p role="status">{results.matches.length} matching lines{results.truncated ? " (first 200; narrow your query)" : ""}. {results.skippedFiles} oversized or non-UTF-8 files skipped.</p>
      <ul className="workspace-tree">{results.matches.map((match) => <li key={`${match.path}:${match.line}`}><button title={match.path} onClick={() => onOpen(match.path)}>{match.path.split(/[\\/]/).pop()}:{match.line} — {match.preview}</button></li>)}</ul></>}
  </section>;
}
