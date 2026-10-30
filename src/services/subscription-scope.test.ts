import { describe, expect, it, vi } from "vitest";
import { subscriptionScope } from "./subscription-scope";

describe("native subscription lifetime", () => {
  it("unregisters a listener that finishes registering after cleanup", async () => {
    let registered!: (unlisten: () => void) => void;
    const registration = new Promise<() => void>((resolve) => { registered = resolve; });
    const scope = subscriptionScope(vi.fn());
    const unlisten = vi.fn();
    scope.add(registration);
    scope.dispose();
    registered(unlisten);
    await registration;
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("reports registration failures while mounted", async () => {
    const error = new Error("registration failed");
    const report = vi.fn();
    const scope = subscriptionScope(report);
    scope.add(Promise.reject(error));
    await Promise.resolve();
    await Promise.resolve();
    expect(report).toHaveBeenCalledExactlyOnceWith(error);
  });

  it("cleanup is idempotent and a remount owns independent listeners", async () => {
    const first = subscriptionScope(vi.fn());
    const second = subscriptionScope(vi.fn());
    const a = vi.fn();
    const b = vi.fn();
    first.add(Promise.resolve(a));
    second.add(Promise.resolve(b));
    await Promise.resolve();
    first.dispose();
    first.dispose();
    expect(a).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
    second.dispose();
    expect(b).toHaveBeenCalledOnce();
  });
});
