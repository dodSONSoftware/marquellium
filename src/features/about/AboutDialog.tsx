import { useState } from "react";
import { version } from "../../../package.json";
import license from "../../../LICENSE?raw";
import logoLight from "../../assets/branding/marquellium-logo-light.svg";
import logoDark from "../../assets/branding/marquellium-logo-dark.svg";
import { Modal } from "../settings/Modal";
import "./about.css";

export function AboutDialog({ onClose, onOpenExternal, suspended = false, theme = "light" }: { onClose: () => void; onOpenExternal: (url: string) => void; suspended?: boolean; theme?: "light" | "dark" }) {
  const [showLicense, setShowLicense] = useState(false);
  return <Modal showTitle={false} title="About Marquellium" className="about-dialog" closeLabel="OK" suspended={suspended} onClose={onClose} footer={<>
          <button type="button" aria-expanded={showLicense} aria-controls="marquellium-license" onClick={() => setShowLicense((open) => !open)}>{showLicense ? "Hide license" : "View license…"}</button>
          <button type="button" onClick={() => onOpenExternal("https://github.com/dodSONSoftware/marquellium")}>GitHub repository…</button>
</>}>
    <div className="about-layout">
      <div className="about-identity">
        <img src={theme === "dark" ? logoDark : logoLight} alt="Marquellium" width={450} height={106} />
        <p>A <b>dodson labs</b> application</p>
      </div>
      <div className="about-details">
        <p className="about-version"><b>Marquellium</b><span>version {version}</span></p>
        <p>Local-first Markdown viewer and editor.</p>
        <dl>
          <dt>Developer</dt><dd>Randy Dodson</dd>
          <dt>Publisher</dt><dd>dodson labs</dd>
          <dt>Copyright</dt><dd>© 2026 Randy Dodson</dd>
          <dt>License</dt><dd>MIT License</dd>
        </dl>

      </div>
    </div>
    {showLicense && <section id="marquellium-license" className="about-license" aria-label="MIT License"><pre>{license}</pre></section>}
  </Modal>;
}
