import { useState } from "react";
import type { Settings } from "../../services/native";
import { PreferencesDialog } from "./PreferencesDialog";
import "./preferences.css";
import { normalizeDisplayScale } from "./ui-scale";
export const typographyDefaults = { readerFont: "system-ui", editorFont: "ui-monospace", fontSize: 16, editorFontSize: 15, lineSpacing: 165, maxWidth: 800 };
export function Preferences({ settings, onSave, onClose, suspended }: { settings: Settings; onSave: (settings: Settings) => Promise<void>; onClose: () => void; suspended?: boolean }) {
  const [draft, setDraft] = useState({ ...typographyDefaults, ...settings, uiScale: normalizeDisplayScale(settings.uiScale), documentScale: normalizeDisplayScale(settings.documentScale) }), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [page, setPage] = useState("appearance");
  const patch = (value: Partial<Settings>) => setDraft((s) => ({ ...s, ...value }));
  return <PreferencesDialog suspended={suspended} onClose={busy ? undefined : onClose} onPlacementError={setError}>
    <form className="preferences-form" noValidate onSubmit={(e) => {
      e.preventDefault();
      if (busy) return;
      const invalid = e.currentTarget.querySelector<HTMLInputElement>("input:invalid");
      if (invalid) {
        setPage(invalid.closest<HTMLElement>("[data-preferences-page]")!.dataset.preferencesPage!);
        setError("Check the highlighted preference before saving.");
        requestAnimationFrame(() => { invalid.focus(); invalid.reportValidity(); });
        return;
      }
      setError(null); setBusy(true);
      void onSave(draft).then(onClose).catch((e) => setError(String(e))).finally(() => setBusy(false));
    }}>
    <div className="preferences-body">
    <nav className="preferences-nav" aria-label="Preferences categories">
      {["appearance", "documents", "editor"].map((id) => <button key={id} type="button" aria-current={page === id ? "page" : undefined} onClick={() => setPage(id)}>{id[0]!.toUpperCase() + id.slice(1)}</button>)}
    </nav>
    <div className="preferences-content">
    <section hidden={page !== "appearance"} data-preferences-page="appearance" aria-labelledby="appearance-title">
    <h3 id="appearance-title">Appearance</h3>
    <label>Appearance <select value={draft.appearance} onChange={(e) => patch({ appearance: e.target.value as Settings["appearance"] })}>{["system", "light", "dark"].map((v) => <option key={v}>{v}</option>)}</select></label>
    <fieldset className="interface-settings"><legend>Interface</legend>
      <label htmlFor="ui-scale">Interface size <output htmlFor="ui-scale">{draft.uiScale}%</output></label>
      <input id="ui-scale" aria-describedby="ui-scale-help" type="range" min={75} max={200} step={5} value={draft.uiScale} onChange={(e) => patch({ uiScale: Number(e.target.value) })} />
      <div className="scale-controls"><span>Smaller</span><button type="button" disabled={busy} onClick={() => patch({ uiScale: 100 })}>Reset to 100%</button><span>Larger</span></div>
      <p id="ui-scale-help">Scales controls, tabs, sidebars, and dialogs after saving. Document size is controlled separately. Native menus and window title bars use the system size.</p>
    </fieldset>
    </section>
    <section hidden={page !== "documents"} data-preferences-page="documents" aria-labelledby="documents-title">
    <h3 id="documents-title">Documents</h3>
    <fieldset className="interface-settings"><legend>Display size</legend>
      <label htmlFor="document-scale">Document size <output htmlFor="document-scale">{draft.documentScale}%</output></label>
      <input id="document-scale" aria-describedby="document-scale-help" type="range" min={75} max={200} step={5} value={draft.documentScale} onChange={(e) => patch({ documentScale: Number(e.target.value) })} />
      <div className="scale-controls"><span>Smaller</span><button type="button" disabled={busy} onClick={() => patch({ documentScale: 100 })}>Reset document to 100%</button><span>Larger</span></div>
      <p id="document-scale-help">Scales document display in Read, Source, Split, and Visual after saving. Does not change Markdown or exported files. Both size settings are saved for future sessions.</p>
    </fieldset>
    <label>Default opening mode <select value={draft.defaultMode} onChange={(e) => patch({ defaultMode: e.target.value as Settings["defaultMode"] })}>{["read", "source", "split", "visual"].map((v) => <option key={v}>{v}</option>)}</select></label>
    <label>Document font <input maxLength={100} value={draft.readerFont} onChange={(e) => patch({ readerFont: e.target.value })} required /></label>
    {([['fontSize', 'Document font size (px)', 12, 40], ['lineSpacing', 'Line spacing (%)', 100, 240], ['maxWidth', 'Document width (px)', 400, 1400]] as const).map(([key, label, min, max]) => <label key={key}>{label} <input type="number" min={min} max={max} value={draft[key]} onChange={(e) => patch({ [key]: Number(e.target.value) })} required /></label>)}
    <label><input type="checkbox" checked={draft.showFrontmatter !== false} onChange={(e) => patch({ showFrontmatter: e.target.checked })} />Show frontmatter</label>
    </section>
    <section hidden={page !== "editor"} data-preferences-page="editor" aria-labelledby="editor-title">
    <h3 id="editor-title">Editor</h3>
    <label>Editor font <input maxLength={100} value={draft.editorFont} onChange={(e) => patch({ editorFont: e.target.value })} required /></label>
    <label>Editor size (px) <input type="number" min={10} max={32} value={draft.editorFontSize} onChange={(e) => patch({ editorFontSize: Number(e.target.value) })} required /></label>
    <label><input type="checkbox" checked={draft.spellcheckEnabled} onChange={(e) => patch({ spellcheckEnabled: e.target.checked })} />Native spell check</label><p>Uses the system WebKit spelling service on editable text. No application network service is used; dictionary availability depends on the OS. Code/source syntax may be flagged as words.</p>
    </section>
    </div>
    </div>
    {error && <p className="preferences-error" role="alert">{error}</p>}
    <footer className="preferences-actions">
    <button type="button" disabled={busy} onClick={() => setDraft({ ...draft, ...typographyDefaults, uiScale: 100, documentScale: 100, appearance: "system", defaultMode: "visual", spellcheckEnabled: true, showFrontmatter: true, sidebar: { visible: true, width: 240, section: "files" } })}>Reset to defaults</button>
    <div><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="preferences-save" disabled={busy}>Save preferences</button></div>
    </footer>
  </form></PreferencesDialog>;
}
