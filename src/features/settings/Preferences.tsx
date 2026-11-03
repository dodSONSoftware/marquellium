import { useState } from "react";
import type { Settings } from "../../services/native";
import { Modal } from "./Modal";
export const typographyDefaults = { readerFont: "system-ui", editorFont: "ui-monospace", fontSize: 16, editorFontSize: 15, lineSpacing: 165, maxWidth: 800 };
export function Preferences({ settings, onSave, onClose, suspended }: { settings: Settings; onSave: (settings: Settings) => Promise<void>; onClose: () => void; suspended?: boolean }) {
  const [draft, setDraft] = useState({ ...typographyDefaults, ...settings }), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const patch = (value: Partial<Settings>) => setDraft((s) => ({ ...s, ...value }));
  return <Modal suspended={suspended} title="Preferences" onClose={busy ? undefined : onClose}><form onSubmit={(e) => { e.preventDefault(); setBusy(true); void onSave(draft).then(onClose).catch((e) => setError(String(e))).finally(() => setBusy(false)); }}>
    <label>Appearance <select value={draft.appearance} onChange={(e) => patch({ appearance: e.target.value as Settings["appearance"] })}>{["system", "light", "dark"].map((v) => <option key={v}>{v}</option>)}</select></label>
    <label>Default opening mode <select value={draft.defaultMode} onChange={(e) => patch({ defaultMode: e.target.value as Settings["defaultMode"] })}>{["read", "source", "split", "visual"].map((v) => <option key={v}>{v}</option>)}</select></label>
    <label>Document font <input maxLength={100} value={draft.readerFont} onChange={(e) => patch({ readerFont: e.target.value })} required /></label>
    <label>Editor font <input maxLength={100} value={draft.editorFont} onChange={(e) => patch({ editorFont: e.target.value })} required /></label>
    {([['fontSize', 'Document size (px)', 12, 40], ['editorFontSize', 'Editor size (px)', 10, 32], ['lineSpacing', 'Line spacing (%)', 100, 240], ['maxWidth', 'Document width (px)', 400, 1400]] as const).map(([key, label, min, max]) => <label key={key}>{label} <input type="number" min={min} max={max} value={draft[key]} onChange={(e) => patch({ [key]: Number(e.target.value) })} required /></label>)}
    <label><input type="checkbox" checked={draft.spellcheckEnabled} onChange={(e) => patch({ spellcheckEnabled: e.target.checked })} />Native spell check</label><p>Uses the system WebKit spelling service on editable text. No application network service is used; dictionary availability depends on the OS. Code/source syntax may be flagged as words.</p>
    <label><input type="checkbox" checked={draft.showFrontmatter !== false} onChange={(e) => patch({ showFrontmatter: e.target.checked })} />Show frontmatter</label>
    <button type="button" disabled={busy} onClick={() => setDraft({ ...draft, ...typographyDefaults, appearance: "system", defaultMode: "visual", spellcheckEnabled: true, showFrontmatter: true, sidebar: { visible: true, width: 240, section: "files" } })}>Reset to defaults</button><button disabled={busy}>Save preferences</button>{error && <p role="alert">{error}</p>}
  </form></Modal>;
}
