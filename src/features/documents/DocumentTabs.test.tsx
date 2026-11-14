// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DocumentTabs } from "./DocumentTabs";
let root: Root, host: HTMLDivElement;
const select = vi.fn(), close = vi.fn(), create = vi.fn(), move = vi.fn(), pin = vi.fn(), reveal = vi.fn();
const documents = [{ docId: "a", name: "Alpha.md", dirty: false, pinned: true, path: "/Alpha.md" }, { docId: "b", name: "Beta.md", dirty: true, path: "/Beta.md" }, { docId: "c", name: "Gamma.md", dirty: false, path: null }];
beforeEach(async () => {
  vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<DocumentTabs tabs={documents} activeId="a" onSelect={select} onClose={close} onNew={create} onMove={move} onPin={pin} onReveal={reveal} />));
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
  await key(tabs()[1]!, "Delete"); expect(close).toHaveBeenLastCalledWith(["b"]);
  await act(async () => (host.querySelector('[aria-label="Close Gamma.md"]') as HTMLButtonElement).click());
  expect(close).toHaveBeenLastCalledWith(["c"]); expect(select).not.toHaveBeenCalled();
  await act(async () => (host.querySelector('[aria-label="New document"]') as HTMLButtonElement).click()); expect(create).toHaveBeenCalledTimes(1);
});
async function openMenu(index: number) {
  await act(async () => tabs()[index]!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
  return [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
}
it("scopes each group close to the clicked tab, in display order, while keeping pins", async () => {
  const actions: [string, string[]][] = [["Close", ["b"]], ["Close Others", ["c"]], ["Close to the Right", ["c"]], ["Close All", ["b", "c"]]];
  for (const [label, expected] of actions) {
    const items = await openMenu(1);
    await act(async () => items.find((item) => item.textContent === label)!.click());
    expect(close).toHaveBeenLastCalledWith(expected);
    expect(host.querySelector('[role="menu"]')).toBeNull();
  }
  expect(select).not.toHaveBeenCalled();
});
it("supports explicit pin and reveal actions on an inactive tab and disables unavailable commands", async () => {
  const mac = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  try {
    let items = await openMenu(1);
    await act(async () => items.find((item) => item.textContent === "Reveal in Finder")!.click());
    expect(reveal).toHaveBeenCalledExactlyOnceWith("b");
    items = await openMenu(0);
    await act(async () => items.find((item) => item.textContent === "Unpin")!.click());
    expect(pin).toHaveBeenCalledExactlyOnceWith("a");
    items = await openMenu(2);
    expect(items.find((item) => item.textContent === "Reveal in Finder")!.disabled).toBe(true);
    expect(items.find((item) => item.textContent === "Close to the Right")!.disabled).toBe(true);
    await act(async () => items.find((item) => item.textContent === "Pin")!.click());
    expect(pin).toHaveBeenLastCalledWith("c");
    expect(select).not.toHaveBeenCalled();
  } finally { mac.mockRestore(); }
});
it("opens from the keyboard, moves menu focus and restores tab focus on Escape", async () => {
  await key(tabs()[1]!, "ContextMenu");
  const items = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  expect(document.activeElement).toBe(items[0]);
  await key(items[0]!, "End"); expect(document.activeElement).toBe(items.at(-1));
  await key(items.at(-1)!, "Escape"); expect(document.activeElement).toBe(tabs()[1]);
  expect(host.querySelector('[role="menu"]')).toBeNull();
});
it("commits a pointer drag on release and suppresses the click that follows it", async () => {
  const source = tabs()[1]!, target = tabs()[2]!;
  source.setPointerCapture = vi.fn();
  const original = document.elementFromPoint;
  document.elementFromPoint = vi.fn().mockReturnValue(target);
  const pointer = async (type: string, x: number) => {
    const event = new MouseEvent(type, { button: 0, clientX: x, bubbles: true });
    Object.defineProperty(event, "pointerId", { value: 3 });
    await act(async () => source.dispatchEvent(event));
  };
  try {
    await pointer("pointerdown", 10); await pointer("pointermove", 70);
    expect(move).not.toHaveBeenCalled(); expect(target.parentElement!.classList.contains("drop-after")).toBe(true);
    await pointer("pointerup", 70);
    await act(async () => source.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
    expect(move).toHaveBeenCalledExactlyOnceWith("b", "c");
    expect(select).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
    await pointer("pointerdown", 20); await pointer("pointermove", 60); await pointer("pointercancel", 60);
    await pointer("pointerup", 60); expect(move).toHaveBeenCalledTimes(1);
  } finally { document.elementFromPoint = original; }
});
