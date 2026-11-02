import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { renderMermaid } from "./controller";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

it("cancels a superseded preview before starting a native process", async () => {
  vi.useFakeTimers();
  const first = new AbortController();
  const obsolete = renderMermaid("flowchart LR\nA-->B", first.signal);
  const rejected = expect(obsolete).rejects.toThrow("cancelled");
  first.abort();
  await rejected;
  expect(invoke).not.toHaveBeenCalled();
  vi.mocked(invoke).mockResolvedValueOnce("<svg/>");
  const current = renderMermaid("flowchart LR\nB-->C", new AbortController().signal);
  await vi.advanceTimersByTimeAsync(149);
  expect(invoke).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(current).resolves.toBe("<svg/>");
  expect(invoke).toHaveBeenCalledWith("previews_mermaid", expect.objectContaining({ source: "flowchart LR\nB-->C" }));
});

it("targets native cancellation to the running request and waits before the next job", async () => {
  vi.useFakeTimers();
  let finish!: (svg: string) => void;
  vi.mocked(invoke).mockImplementation((command) => command === "previews_mermaid"
    ? new Promise((resolve) => { finish = resolve as (svg: string) => void; }) : Promise.resolve());
  const abort = new AbortController();
  const rendering = renderMermaid("flowchart LR\nA-->B", abort.signal);
  await vi.advanceTimersByTimeAsync(150);
  const [, args] = vi.mocked(invoke).mock.calls[0]!;
  abort.abort();
  expect(invoke).toHaveBeenLastCalledWith("previews_cancel", { requestId: (args as { requestId: string }).requestId });
  const waitingAbort = new AbortController();
  const waiting = renderMermaid("flowchart LR\nB-->C", waitingAbort.signal);
  const rejected = expect(waiting).rejects.toThrow("cancelled");
  await vi.advanceTimersByTimeAsync(500);
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "previews_mermaid")).toHaveLength(1);
  waitingAbort.abort();
  finish("<svg/>");
  await rendering;
  await rejected;
});
