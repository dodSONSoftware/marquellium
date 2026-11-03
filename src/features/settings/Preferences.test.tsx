// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Preferences } from "./Preferences";
import { statistics } from "./useStatistics";
it("counts Unicode characters and gives approximate reading time", () => {
  expect(statistics("café 東京 🎉")).toEqual({ words: 2, characters: 9, minutes: 1 });
  expect(statistics("")).toEqual({ words: 0, characters: 0, minutes: 0 });
});
it("resets visible preferences and saves without mutating the supplied settings", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  const host = document.createElement("div"), root = createRoot(host), save = vi.fn(async () => {}), close = vi.fn();
  const settings = { schemaVersion: 1, appearance: "dark" as const, defaultMode: "source" as const, spellcheckEnabled: false, fontSize: 30, sidebar: { visible: false, width: 320, section: "toc" as const } };
  try {
    await act(async () => root.render(<Preferences settings={settings} onSave={save} onClose={close} />));
    await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Reset to defaults")!.click());
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ fontSize: 16, defaultMode: "visual", appearance: "system", spellcheckEnabled: true }));
    expect(settings.fontSize).toBe(30); expect(close).toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});
it("suspends the top-layer preferences dialog during document resolution and retains its draft", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  const host = document.createElement("div"), root = createRoot(host);
  const settings = { schemaVersion: 1, appearance: "system" as const, defaultMode: "visual" as const, spellcheckEnabled: true, sidebar: { visible: true, width: 240, section: "files" as const } };
  const props = { settings, onSave: vi.fn(async () => {}), onClose: vi.fn() };
  try {
    await act(async () => root.render(<Preferences {...props} />));
    const font = [...host.querySelectorAll("input")].find((el) => el.value === "system-ui")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(font, "Georgia"); font.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => root.render(<Preferences {...props} suspended />));
    expect(host.querySelector("dialog")!.open).toBe(false);
    await act(async () => root.render(<Preferences {...props} suspended={false} />));
    expect(host.querySelector("dialog")!.open).toBe(true); expect(font.value).toBe("Georgia");
    expect(props.onSave).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});

it("edits interface size as a local draft and saves the selected percentage", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  const host = document.createElement("div"), root = createRoot(host), save = vi.fn(async () => {}), close = vi.fn();
  const settings = { schemaVersion: 1, appearance: "system" as const, defaultMode: "visual" as const, spellcheckEnabled: true, sidebar: { visible: true, width: 240, section: "files" as const } };
  try {
    await act(async () => root.render(<Preferences settings={settings} onSave={save} onClose={close} />));
    const slider = host.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect(slider.value).toBe("100");
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(slider, "150"); slider.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(host.querySelector("output")?.textContent).toBe("150%"); expect(save).not.toHaveBeenCalled();
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ uiScale: 150 })); expect(settings).not.toHaveProperty("uiScale");
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});
it("offers a dedicated normal-size reset and closing does not save the draft", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  const host = document.createElement("div"), root = createRoot(host), save = vi.fn(async () => {}), close = vi.fn();
  const settings = { schemaVersion: 1, appearance: "dark" as const, defaultMode: "source" as const, spellcheckEnabled: true, uiScale: 200, sidebar: { visible: true, width: 240, section: "files" as const } };
  try {
    await act(async () => root.render(<Preferences settings={settings} onSave={save} onClose={close} />));
    await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Reset to 100%")!.click());
    expect(host.querySelector("output")?.textContent).toBe("100%");
    await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Close")!.click());
    expect(close).toHaveBeenCalledTimes(1); expect(save).not.toHaveBeenCalled(); expect(settings.uiScale).toBe(200);
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});

it("resets document scale independently of interface size and font preferences", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  const host = document.createElement("div"), root = createRoot(host), save = vi.fn(async () => {});
  const settings = { schemaVersion: 1, appearance: "system" as const, defaultMode: "visual" as const, spellcheckEnabled: true, uiScale: 150, documentScale: 175, fontSize: 20, sidebar: { visible: true, width: 240, section: "files" as const } };
  try {
    await act(async () => root.render(<Preferences settings={settings} onSave={save} onClose={() => {}} />));
    await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Reset document to 100%")!.click());
    const ranges = host.querySelectorAll<HTMLInputElement>('input[type="range"]');
    expect(ranges[0]!.value).toBe("150"); expect(ranges[1]!.value).toBe("100");
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ uiScale: 150, documentScale: 100, fontSize: 20 }));
    expect(settings.documentScale).toBe(175);
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});
