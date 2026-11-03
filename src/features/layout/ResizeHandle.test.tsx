// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ResizeHandle } from "./ResizeHandle";
it("exposes focusable range semantics and bounds keyboard resizing", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host), resize = vi.fn(), pointer = vi.fn();
  try {
    await act(async () => root.render(<ResizeHandle className="handle" label="Resize sidebar" value={240} min={180} max={560} step={10} unit="pixels" onResize={resize} onPointerDown={pointer} />));
    const handle = host.querySelector<HTMLDivElement>('[role="separator"]')!;
    expect(handle.tabIndex).toBe(0); expect(handle.getAttribute("aria-valuetext")).toBe("240 pixels"); expect(handle.getAttribute("aria-valuemin")).toBe("180"); expect(handle.getAttribute("aria-valuemax")).toBe("560");
    for (const [key, expected] of [["ArrowLeft", 230], ["ArrowRight", 250], ["Home", 180], ["End", 560]] as const) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      await act(async () => { handle.dispatchEvent(event); }); expect(resize).toHaveBeenLastCalledWith(expected); expect(event.defaultPrevented).toBe(true);
    }
    await act(async () => root.render(<ResizeHandle className="handle" label="Resize split panes" value={79} min={20} max={80} step={5} unit="percent" onResize={resize} onPointerDown={pointer} />));
    await act(async () => { handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); }); expect(resize).toHaveBeenLastCalledWith(80);
    resize.mockClear(); const ignored = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    await act(async () => { handle.dispatchEvent(ignored); handle.dispatchEvent(new Event("pointerdown", { bubbles: true })); }); expect(resize).not.toHaveBeenCalled(); expect(ignored.defaultPrevented).toBe(false); expect(pointer).toHaveBeenCalledTimes(1);
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
