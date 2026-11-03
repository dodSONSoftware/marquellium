// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useFileOpenRequests } from "./useFileOpenRequests";
import { native, type FileOpenRequest } from "../../services/native";
const events = vi.hoisted(() => ({ pending: () => {}, release: () => {} }));
vi.mock("../../services/native", () => ({ isTauri: () => true, native: { fileOpen: { next: vi.fn(), ack: vi.fn() } },
  onFileOpenPending: async (cb: () => void) => { events.pending = cb; return vi.fn(); },
  onLifecycleRelease: async (cb: () => void) => { events.release = cb; return vi.fn(); },
}));
let root: Root, container: HTMLDivElement;
let ready: boolean, queue: FileOpenRequest[];
const open = vi.fn(async (_path: string) => true), report = vi.fn();
function Harness() {
  const state = useFileOpenRequests(ready, open, report);
  return <><span>{state.pending?.path}</span><button onClick={state.retry}>retry</button><button onClick={() => void state.dismiss()}>dismiss</button></>;
}
beforeEach(async () => {
  vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  ready = false; queue = [{ id: 1, path: "/notes/東京.md", error: null }]; open.mockResolvedValue(true);
  vi.mocked(native.fileOpen.next).mockImplementation(async () => queue[0] ?? null);
  vi.mocked(native.fileOpen.ack).mockImplementation(async (id) => { queue = queue.filter((r) => r.id !== id); });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function start() { ready = true; await act(async () => root.render(<Harness />)); }
async function click(label: string) { await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent === label)!.click()); }
it("waits for startup and recovery, drains successful requests once despite duplicate events", async () => {
  expect(open).not.toHaveBeenCalled(); await start();
  await act(async () => { events.pending(); events.pending(); events.release(); });
  expect(open).toHaveBeenCalledExactlyOnceWith("/notes/東京.md"); expect(queue).toEqual([]);
});
it("retains a canceled request without reprompting and retries explicitly", async () => {
  open.mockResolvedValueOnce(false); await start(); expect(queue).toHaveLength(1);
  await act(async () => { events.release(); events.pending(); }); expect(open).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("/notes/東京.md"); await click("retry"); expect(queue).toEqual([]); expect(open).toHaveBeenCalledTimes(2);
});
it("dismisses only the canceled request, then opens the next", async () => {
  queue.push({ id: 2, path: "/next.md", error: null }); open.mockResolvedValueOnce(false); await start();
  await click("dismiss"); expect(open.mock.calls.map(([path]) => path)).toEqual(["/notes/東京.md", "/next.md"]); expect(queue).toEqual([]);
});
it("reports invalid paths and continues with the following valid request", async () => {
  queue.unshift({ id: 0, path: null, error: "Cannot open missing.md" }); await start();
  expect(report).toHaveBeenCalledWith("Cannot open missing.md"); expect(open).toHaveBeenCalledTimes(1); expect(queue).toEqual([]);
});
