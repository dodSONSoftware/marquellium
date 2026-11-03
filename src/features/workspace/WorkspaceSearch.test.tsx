// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
const search = vi.hoisted(() => vi.fn());
vi.mock("../../services/native", () => ({ native: { workspace: { search } } }));
import { WorkspaceSearch } from "./WorkspaceSearch";
afterEach(() => { vi.unstubAllGlobals(); search.mockReset(); });
it("searches saved files with exclusions and opens a matching document", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  search.mockResolvedValue({ matches: [{ path: "/work/東京.md", line: 2, preview: "東京 needle" }], skippedFiles: 1, truncated: true });
  const host = document.createElement("div"), root = createRoot(host), open = vi.fn();
  try {
    await act(async () => root.render(<WorkspaceSearch patterns={["vendor"]} onOpen={open} />));
    const input = host.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "needle");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(search).toHaveBeenCalledWith("needle", ["vendor"]);
    expect(host.textContent).toContain("first 200");
    expect(host.textContent).toContain("1 oversized");
    await act(async () => host.querySelector("li button")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(open).toHaveBeenCalledWith("/work/東京.md");
    search.mockRejectedValue(new Error("search budget exceeded"));
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("search budget exceeded");
    expect(host.querySelector("li")).toBeNull();
  } finally { await act(async () => root.unmount()); }
});
