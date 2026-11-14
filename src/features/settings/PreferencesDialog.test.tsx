// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Preferences } from "./Preferences";
import { fitPreferencesBounds } from "./PreferencesDialog";

const key = "marquellium.preferences-dialog.v1";
const settings = { schemaVersion: 1, appearance: "dark" as const, defaultMode: "visual" as const, spellcheckEnabled: true, sidebar: { visible: true, width: 240, section: "files" as const } };

it("keeps moved and resized bounds across reopening and constrains them to a smaller viewport", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  localStorage.setItem(key, JSON.stringify({ x: 20, y: 30, width: 700, height: 500 }));
  const host = document.createElement("div"); document.body.append(host);
  let root = createRoot(host);
  const props = { settings, onSave: vi.fn(async () => {}), onClose: vi.fn() };
  async function pointer(element: HTMLElement, type: string, x: number, y: number) {
    const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
    Object.defineProperty(event, "pointerId", { value: 1 });
    await act(async () => element.dispatchEvent(event));
  }
  try {
    await act(async () => root.render(<Preferences {...props} />));
    const title = host.querySelector<HTMLElement>("header")!;
    title.setPointerCapture = vi.fn();
    await pointer(title, "pointerdown", 40, 40);
    await pointer(title, "pointermove", 110, 80);
    await pointer(title, "pointerup", 110, 80);
    const resize = host.querySelector<HTMLButtonElement>('[aria-label="Resize preferences"]')!;
    resize.setPointerCapture = vi.fn();
    await pointer(resize, "pointerdown", 700, 500);
    await pointer(resize, "pointermove", 750, 540);
    await pointer(resize, "pointerup", 750, 540);
    await act(async () => root.unmount());
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ x: 90, y: 70, width: 750, height: 540 });
    root = createRoot(host);
    await act(async () => root.render(<Preferences {...props} />));
    const dialog = host.querySelector("dialog")!;
    expect([dialog.style.left, dialog.style.top, dialog.style.width, dialog.style.height]).toEqual(["90px", "70px", "750px", "540px"]);
    expect(props.onSave).not.toHaveBeenCalled();
    expect(fitPreferencesBounds({ x: 90, y: 70, width: 750, height: 540 }, 500, 320)).toEqual({ x: 8, y: 8, width: 484, height: 304 });
  } finally {
    await act(async () => root.unmount()); host.remove(); localStorage.clear(); vi.unstubAllGlobals();
  }
});

it("switches pages without losing edits and retains drafts after a save failure", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host), save = vi.fn(async () => { throw new Error("Save failed"); }), close = vi.fn();
  const page = (id: string) => host.querySelector<HTMLElement>(`[data-preferences-page="${id}"]`)!;
  async function select(name: string) { await act(async () => [...host.querySelectorAll<HTMLButtonElement>("nav button")].find((b) => b.textContent === name)!.click()); }
  try {
    localStorage.setItem(key, '{"x":null,"width":"invalid"}');
    await act(async () => root.render(<Preferences settings={settings} onSave={save} onClose={close} />));
    expect(page("appearance").hidden).toBe(false); expect(page("documents").hidden).toBe(true);
    await select("Documents");
    const font = [...page("documents").querySelectorAll("input")].find((input) => input.value === "system-ui")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(font, "Georgia");
      font.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await select("Editor"); await select("Documents");
    expect(font.value).toBe("Georgia");
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ readerFont: "Georgia" }));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Save failed");
    expect(close).not.toHaveBeenCalled();
    expect(font.value).toBe("Georgia");
  } finally {
    await act(async () => root.unmount()); host.remove(); localStorage.clear(); vi.unstubAllGlobals();
  }
});
