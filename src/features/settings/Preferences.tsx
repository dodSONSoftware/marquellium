import { useState } from "react";
import type { Settings } from "../../services/native";
import { Modal } from "./Modal";
import { normalizeDisplayScale } from "./ui-scale";
export const typographyDefaults = { readerFont: "system-ui", editorFont: "ui-monospace", fontSize: 16, editorFontSize: 15, lineSpacing: 165, maxWidth: 800 };
export function Preferences({ settings, onSave, onClose, suspended }: { settings: Settings; onSave: (settings: Settings) => Promise<void>; onClose: () => void; suspended?: boolean }) {
  const [draft, setDraft] = useState({ ...typographyDefaults, ...settings, uiScale: normalizeDisplayScale(settings.uiScale), documentScale: normalizeDisplayScale(settings.documentScale) }), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const patch = (value: Partial<Settings>) => setDraft((s) => ({ ...s, ...value }));
  return <Modal suspended={suspended} title="Preferences" onClose={busy ? undefined : onClose}><form onSubmit={(e) => { e.preventDefault(); setBusy(true); void onSave(draft).then(onClose).catch((e) => setError(String(e))).finally(() => setBusy(false)); }}>
    <fieldset className="interface-settings"><legend>Interface</legend>
      <label htmlFor="ui-scale">Interface size <output htmlFor="ui-scale">{draft.uiScale}%</output></label>
      <input id="ui-scale" aria-describedby="ui-scale-help" type="range" min={75} max={200} step={5} value={draft.uiScale} onChange={(e) => patch({ uiScale: Number(e.target.value) })} />
      <div className="scale-controls"><span>Smaller</span><button type="button" disabled={busy} onClick={() => patch({ uiScale: 100 })}>Reset to 100%</button><span>Larger</span></div>
      <p id="ui-scale-help">Scales controls, tabs, sidebars, and dialogs after saving. Document size is controlled separately. Native menus and window title bars use the system size.</p>
    </fieldset>
    <fieldset className="interface-settings"><legend>Documents</legend>
      <label htmlFor="document-scale">Document size <output htmlFor="document-scale">{draft.documentScale}%</output></label>
      <input id="document-scale" aria-describedby="document-scale-help" type="range" min={75} max={200} step={5} value={draft.documentScale} onChange={(e) => patch({ documentScale: Number(e.target.value) })} />
      <div className="scale-controls"><span>Smaller</span><button type="button" disabled={busy} onClick={() => patch({ documentScale: 100 })}>Reset document to 100%</button><span>Larger</span></div>
      <p id="document-scale-help">Scales document display in Read, Source, Split, and Visual after saving. Does not change Markdown or exported files. Both size settings are saved for future sessions.</p>
    </fieldset>
    <label>Appearance <select value={draft.appearance} onChange={(e) => patch({ appearance: e.target.value as Settings["appearance"] })}>{["system", "light", "dark"].map((v) => <option key={v}>{v}</option>)}</select></label>
    <label>Default opening mode <select value={draft.defaultMode} onChange={(e) => patch({ defaultMode: e.target.value as Settings["defaultMode"] })}>{["read", "source", "split", "visual"].map((v) => <option key={v}>{v}</option>)}</select></label>
    <label>Document font <input maxLength={100} value={draft.readerFont} onChange={(e) => patch({ readerFont: e.target.value })} required /></label>
    <label>Editor font <input maxLength={100} value={draft.editorFont} onChange={(e) => patch({ editorFont: e.target.value })} required /></label>
    {([['fontSize', 'Document font size (px)', 12, 40], ['editorFontSize', 'Editor size (px)', 10, 32], ['lineSpacing', 'Line spacing (%)', 100, 240], ['maxWidth', 'Document width (px)', 400, 1400]] as const).map(([key, label, min, max]) => <label key={key}>{label} <input type="number" min={min} max={max} value={draft[key]} onChange={(e) => patch({ [key]: Number(e.target.value) })} required /></label>)}
    <label><input type="checkbox" checked={draft.spellcheckEnabled} onChange={(e) => patch({ spellcheckEnabled: e.target.checked })} />Native spell check</label><p>Uses the system WebKit spelling service on editable text. No application network service is used; dictionary availability depends on the OS. Code/source syntax may be flagged as words.</p>
    <label><input type="checkbox" checked={draft.showFrontmatter !== false} onChange={(e) => patch({ showFrontmatter: e.target.checked })} />Show frontmatter</label>
    <button type="button" disabled={busy} onClick={() => setDraft({ ...draft, ...typographyDefaults, uiScale: 100, documentScale: 100, appearance: "system", defaultMode: "visual", spellcheckEnabled: true, showFrontmatter: true, sidebar: { visible: true, width: 240, section: "files" } })}>Reset to defaults</button><button disabled={busy}>Save preferences</button>{error && <p role="alert">{error}</p>}
  </form></Modal>;
}
