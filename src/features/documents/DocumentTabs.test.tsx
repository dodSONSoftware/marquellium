// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DocumentTabs } from "./DocumentTabs";
let root: Root, host: HTMLDivElement;
const select = vi.fn(), close = vi.fn(), create = vi.fn(), move = vi.fn();
const documents = [{ docId: "a", name: "Alpha.md", dirty: false }, { docId: "b", name: "Beta.md", dirty: true }, { docId: "c", name: "Gamma.md", dirty: false }];
beforeEach(async () => {
  vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<DocumentTabs tabs={documents} activeId="a" onSelect={select} onClose={close} onNew={create} onMove={move} />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
function tabs() { return [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]; }
async function key(button: HTMLButtonElement, value: string) { await act(async () => { button.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })); }); }
it("exposes named selection and unsaved status with independent close controls", () => {
  expect(host.querySelector('[role="tablist"]')?.getAttribute("aria-label")).toBe("Documents");
  expect(tabs().map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
  expect(tabs().map((tab) => tab.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
  expect(tabs()[1]!.querySelector('[aria-label="unsaved changes"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="Close Beta.md"]')?.closest('[role="tab"]')).toBeNull();
});
it("moves focus with arrows and Home/End without changing documents before activation", async () => {
  tabs()[0]!.focus(); await key(tabs()[0]!, "ArrowLeft"); expect(document.activeElement).toBe(tabs()[2]);
  await key(tabs()[2]!, "ArrowRight"); expect(document.activeElement).toBe(tabs()[0]);
  await key(tabs()[0]!, "End"); expect(document.activeElement).toBe(tabs()[2]);
  await key(tabs()[2]!, "Home"); expect(document.activeElement).toBe(tabs()[0]); expect(select).not.toHaveBeenCalled();
  await act(async () => tabs()[1]!.click()); expect(select).toHaveBeenCalledExactlyOnceWith("b");
  // Selection remains authoritative in the caller, including after a canceled draft prompt.
  expect(tabs()[0]!.getAttribute("aria-selected")).toBe("true"); expect(tabs()[1]!.getAttribute("aria-selected")).toBe("false");
});
it("routes Delete and close buttons to close resolution without selecting the tab", async () => {
  await key(tabs()[1]!, "Delete"); expect(close).toHaveBeenLastCalledWith("b");
  await act(async () => (host.querySelector('[aria-label="Close Gamma.md"]') as HTMLButtonElement).click());
  expect(close).toHaveBeenLastCalledWith("c"); expect(select).not.toHaveBeenCalled();
  await act(async () => (host.querySelector('[aria-label="New document"]') as HTMLButtonElement).click()); expect(create).toHaveBeenCalledTimes(1);
});
it("keeps drag reordering separate from activation and closing", async () => {
  const transfer = { effectAllowed: "", dropEffect: "", setData: vi.fn() };
  async function drag(index: number, name: string) { const event = new Event(name, { bubbles: true, cancelable: true }); Object.defineProperty(event, "dataTransfer", { value: transfer }); await act(async () => host.querySelectorAll('.tab')[index]!.dispatchEvent(event)); }
  await drag(0, "dragstart"); await drag(2, "dragover");
  expect(transfer.setData).toHaveBeenCalledWith("text/plain", "a"); expect(move).toHaveBeenCalledExactlyOnceWith(0, 2);
  await drag(2, "dragend"); await drag(1, "dragover"); expect(move).toHaveBeenCalledTimes(1); expect(select).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
});
