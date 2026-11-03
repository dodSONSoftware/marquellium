// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ folder: vi.fn(), list: vi.fn() }));
vi.mock("../../services/native", () => ({ native: { dialogs: { openFolder: api.folder }, workspace: { list: api.list, root: async () => null } } }));
import { WorkspaceTree } from "./WorkspaceTree";
it("opens a granted folder, lazily expands directories and routes files through the caller", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.folder.mockResolvedValue("/work");
  api.list.mockImplementation(async (path: string) => path === "/work" ? [{ name: "notes", path: "/work/notes", isDir: true }] : [{ name: "a.md", path: "/work/notes/a.md", isDir: false }]);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host), open = vi.fn();
  const click = async (text: string) => { await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(text))!.click()); };
  try {
    await act(async () => root.render(<WorkspaceTree onOpen={open} />));
    await click("Open folder"); expect(api.list).toHaveBeenCalledWith("/work", ["node_modules", "target", "dist"]);
    expect(api.list).not.toHaveBeenCalledWith("/work/notes", expect.anything());
    await click("notes"); await click("a.md"); expect(open).toHaveBeenCalledWith("/work/notes/a.md");
    api.list.mockRejectedValueOnce(new Error("outside scope")); await click("Refresh files"); expect(host.textContent).toContain("outside scope");
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
