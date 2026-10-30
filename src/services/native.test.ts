import { beforeEach, describe, expect, it, vi } from "vitest";

const events = vi.hoisted(() => ({
  label: "main",
  subscriptions: [] as {
    event: string;
    handler: (event: { payload: unknown }) => void;
    target?: { kind: string; label: string };
  }[],
}));

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
  EV_MENU_COMMAND,
  EV_WINDOW_CLOSE_REQUESTED,
  onMenuCommand,
  onWindowCloseRequested,
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
