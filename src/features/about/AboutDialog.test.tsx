// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { version } from "../../../package.json";
import license from "../../../LICENSE?raw";
import { AboutDialog } from "./AboutDialog";

it("shows current application details, the bundled license and the verified repository action", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  const host = document.createElement("div"), root = createRoot(host), close = vi.fn(), external = vi.fn(); document.body.append(host);
  try {
    await act(async () => root.render(<AboutDialog onClose={close} onOpenExternal={external} />));
    const dialog = host.querySelector("dialog")!;
    expect([...host.querySelectorAll(".modal-actions > button")].map((button) => button.textContent)).toEqual(["View license…", "GitHub repository…", "OK"]);
    expect(host.querySelector(".about-identity img")?.getAttribute("src")).toContain("marquellium-logo-light.svg");
    expect(dialog.querySelector("h2")).toBeNull();
    expect(dialog.getAttribute("aria-label")).toBe("About Marquellium"); expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain(`version ${version}`); expect(dialog.textContent).toContain("Randy Dodson"); expect(dialog.textContent).toContain("dodson labs");
    const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === text)!;
    expect(host.querySelector("pre")).toBeNull();
    await act(async () => button("View license…").click()); expect(host.querySelector("pre")!.textContent).toBe(license);
    expect(button("Hide license").getAttribute("aria-expanded")).toBe("true");
    await act(async () => button("Hide license").click()); expect(host.querySelector("pre")).toBeNull();
    await act(async () => button("GitHub repository…").click()); expect(external).toHaveBeenCalledExactlyOnceWith("https://github.com/dodSONSoftware/marquellium");
    await act(async () => button("OK").click()); expect(close).toHaveBeenCalledTimes(1);
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});

it("suspends for document resolution, closes with Escape and restores the logo opener's focus", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  const host = document.createElement("div"), opener = document.createElement("button"), root = createRoot(host), close = vi.fn(); document.body.append(opener, host); opener.focus();
  const props = { onClose: close, onOpenExternal: vi.fn() };
  try {
    await act(async () => root.render(<AboutDialog {...props} />));
    await act(async () => root.render(<AboutDialog {...props} suspended />)); expect(host.querySelector("dialog")!.open).toBe(false);
    await act(async () => root.render(<AboutDialog {...props} suspended={false} />)); expect(host.querySelector("dialog")!.open).toBe(true);
    const cancel = new Event("cancel", { cancelable: true });
    await act(async () => host.querySelector("dialog")!.dispatchEvent(cancel)); expect(close).toHaveBeenCalledTimes(1); expect(cancel.defaultPrevented).toBe(true);
    await act(async () => root.unmount()); expect(document.activeElement).toBe(opener);
  } finally { if (host.firstChild) await act(async () => root.unmount()); host.remove(); opener.remove(); vi.unstubAllGlobals(); }
});

it("uses the same theme-specific wordmark assets as the header", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  const host = document.createElement("div"), root = createRoot(host);
  try {
    await act(async () => root.render(<AboutDialog theme="dark" onClose={() => {}} onOpenExternal={() => {}} />));
    expect(host.querySelector(".about-identity img")?.getAttribute("src")).toContain("marquellium-logo-dark.svg");
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});
