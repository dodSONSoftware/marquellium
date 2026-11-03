// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";
it("filters, skips disabled commands, executes with keyboard and restores focus", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"), opener = document.createElement("button"); document.body.append(opener, host); opener.focus();
  const root = createRoot(host), run = vi.fn(), close = vi.fn();
  await act(async () => root.render(<CommandPalette onClose={close} commands={[{ id: "open", label: "Open document", run }, { id: "delete", label: "Delete", run, disabled: true }, { id: "visual", label: "Switch Visual", run }]} />));
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Find a command");
  expect(host.querySelectorAll('[role="option"]')).toHaveLength(2);
  const input = host.querySelector("input")!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "visual"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(host.querySelectorAll('[role="option"]')).toHaveLength(1);
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(run).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  await act(async () => root.unmount()); expect(document.activeElement).toBe(opener); host.remove(); opener.remove(); vi.unstubAllGlobals();
});
