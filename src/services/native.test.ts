import { readFileSync } from "node:fs";
import { invoke } from "@tauri-apps/api/core";
import type { DraftOpening } from "../core/draft-session";
import { beforeEach, describe, expect, it, vi } from "vitest";

const events = vi.hoisted(() => ({
  label: "main",
  subscriptions: [] as {
    event: string;
    handler: (event: { payload: unknown }) => void;
    target?: { kind: string; label: string };
  }[],
}));

const createdWindows = vi.hoisted(() => [] as string[]);
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: class { constructor(label: string) { createdWindows.push(label); } },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: events.label,
    onCloseRequested: async (callback: (event: { preventDefault: () => void }) => void) => {
      const subscription = {
        event: "tauri://close-requested",
        target: { kind: "Window", label: events.label },
        handler: () => {
          const preventDefault = vi.fn();
          callback({ preventDefault });
          expect(preventDefault).toHaveBeenCalledOnce();
        },
      };
      events.subscriptions.push(subscription);
      return () => { events.subscriptions = events.subscriptions.filter((s) => s !== subscription); };
    },
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event, handler, options) => {
    const subscription = { event, handler, target: options?.target };
    events.subscriptions.push(subscription);
    return () => {
      events.subscriptions = events.subscriptions.filter((s) => s !== subscription);
    };
  }),
}));

import {
  native,
  openNewWindow,
  EV_MENU_COMMAND,
  EV_WINDOW_CLOSE_REQUESTED,
  onMenuCommand,
  onWindowCloseRequested,
  onDocumentSaved,
  EV_DOC_SAVED,
  onLifecycleRequest,
} from "./native";

// Model explicit Window emission: an unscoped (Any) subscription would
// receive both windows' events, as in Tauri's event API.
function emitToWindow(label: string, event: string, payload: unknown) {
  for (const subscription of events.subscriptions) {
    if (subscription.event === event && (!subscription.target ||
      (subscription.target.kind === "Window" && subscription.target.label === label))) {
      subscription.handler({ payload });
    }
  }
}

beforeEach(() => {
  events.label = "main";
  events.subscriptions = [];
});

describe("window-scoped native events", () => {
  it("routes lifecycle owner requests only to their target and includes the exact selected documents", async () => {
    events.label = "main";
    const first = vi.fn(); const stopFirst = await onLifecycleRequest(first);
    events.label = "visual-owner";
    const second = vi.fn(); const stopSecond = await onLifecycleRequest(second);
    emitToWindow("visual-owner", "lifecycle-request", { id: 1, action: "resolve-draft", body: {} });
    expect(first).not.toHaveBeenCalled(); expect(second).toHaveBeenCalledOnce();
    await native.lifecycle.begin("tab-switch", ["affected"]);
    expect(invoke).toHaveBeenLastCalledWith("lifecycle_begin", { trigger: "tab-switch", docIds: ["affected"] });
    stopFirst(); stopSecond();
  });
  it("delivers document save metadata to every window viewing the shared registry", async () => {
    const first = vi.fn(), second = vi.fn();
    events.label = "main";
    const stopFirst = await onDocumentSaved(first);
    events.label = "visual-second";
    const stopSecond = await onDocumentSaved(second);
    emitToWindow("main", EV_DOC_SAVED, { docId: "shared" });
    expect(first).toHaveBeenCalledWith({ docId: "shared" });
    expect(second).toHaveBeenCalledWith({ docId: "shared" });
    stopFirst(); stopSecond();
  });
  it.each(["new", "open", "save", "close_tab", "quit"])("routes %s to its window only", async (id) => {
    const a = vi.fn();
    const b = vi.fn();
    const unlistenA = await onMenuCommand(a);
    events.label = "second";
    await onMenuCommand(b);
    emitToWindow("main", EV_MENU_COMMAND, { id });
    expect(a).toHaveBeenCalledExactlyOnceWith(id);
    expect(b).not.toHaveBeenCalled();
    emitToWindow("second", EV_MENU_COMMAND, { id });
    expect(b).toHaveBeenCalledExactlyOnceWith(id);
    expect(a).toHaveBeenCalledTimes(1);
    unlistenA();
    emitToWindow("main", EV_MENU_COMMAND, { id });
    expect(a).toHaveBeenCalledTimes(1);
  });

  it("closing one window does not request closure of another", async () => {
    const a = vi.fn();
    const b = vi.fn();
    await onWindowCloseRequested(a);
    events.label = "second";
    await onWindowCloseRequested(b);
    emitToWindow("second", EV_WINDOW_CLOSE_REQUESTED, null);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledOnce();
  });
});


describe("owner-derived draft command facade", () => {
  it("sends source ranges and tokens, never a caller-supplied owner window", async () => {
    const opening: DraftOpening = { baseRevision: 4, startByte: 3, endByte: 8, openingText: "table", kind: "table" };
    await native.drafts.acquire("doc", opening);
    expect(invoke).toHaveBeenLastCalledWith("drafts_acquire", { docId: "doc", opening });
    const update = { generation: 1, text: "draft", valid: true };
    await native.drafts.update("doc", "token", update);
    expect(invoke).toHaveBeenLastCalledWith("drafts_update", { docId: "doc", token: "token", update });
    await native.drafts.apply("doc", "token", 1, []);
    expect(invoke).toHaveBeenLastCalledWith("drafts_apply", { docId: "doc", token: "token", generation: 1, ops: [] });
    await native.drafts.release("doc", "token");
    expect(invoke).toHaveBeenLastCalledWith("drafts_release", { docId: "doc", token: "token" });
    await native.drafts.resume("doc", "orphan");
    expect(invoke).toHaveBeenLastCalledWith("drafts_resume", { docId: "doc", token: "orphan" });
  });

  it("uses the protected localized command rather than the unrestricted Source command", async () => {
    await native.documents.applyLocalized("doc", 4, []);
    expect(invoke).toHaveBeenLastCalledWith("documents_apply_localized", { docId: "doc", baseRevision: 4, ops: [] });
  });
});

it("opens multiple independent windows with identities covered by the native capability", async () => {
  createdWindows.length = 0;
  await openNewWindow(); await openNewWindow(); await openNewWindow();
  expect(new Set(createdWindows).size).toBe(3);
  expect(createdWindows.every((label) => label.startsWith("window-"))).toBe(true);
  const capability = JSON.parse(readFileSync("src-tauri/capabilities/default.json", "utf8")) as { windows: string[] };
  expect(capability.windows).toContain("window-*");
  expect(capability.windows).not.toContain("*");
});
