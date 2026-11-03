// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ToolbarMenu } from "./ToolbarMenu";

it("keeps fields usable, dismisses commands/outside clicks, and restores summary focus on Escape", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host), run = vi.fn();
  try {
    await act(async () => root.render(<ToolbarMenu label="Application tools"><input aria-label="Assets folder" /><button onClick={run}>Export</button><button disabled>Unavailable</button></ToolbarMenu>));
    const menu = host.querySelector("details")!, summary = host.querySelector("summary")!, input = host.querySelector("input")!;
    expect(summary.getAttribute("aria-label")).toBe("Application tools");
    menu.open = true;
    await act(async () => input.click()); expect(menu.open).toBe(true);
    await act(async () => host.querySelectorAll("button")[1]!.click()); expect(menu.open).toBe(true);
    input.focus();
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => input.dispatchEvent(escape)); expect(menu.open).toBe(false); expect(document.activeElement).toBe(summary); expect(escape.defaultPrevented).toBe(true);
    menu.open = true; input.focus();
    await act(async () => host.querySelector("button")!.click()); expect(run).toHaveBeenCalledTimes(1); expect(menu.open).toBe(false); expect(document.activeElement).toBe(summary);
    menu.open = true;
    await act(async () => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }))); expect(menu.open).toBe(false);
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
