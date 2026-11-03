// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useLifecycle } from "./useLifecycle";
import { DraftSession, type DraftLease, type DraftPort } from "../../core/draft-session";
import { createSourceMap } from "../../core/source-map";
import { DirectTextController } from "../visual/direct-edit";
import { native, type LifecycleRequest } from "../../services/native";

const events = vi.hoisted(() => ({ request: null as ((request: LifecycleRequest) => void) | null, release: null as ((transaction: number) => void) | null, error: null as ((error: string) => void) | null }));
vi.mock("../../services/native", () => ({
  isTauri: () => true,
  native: { lifecycle: { begin: vi.fn(async () => true), reply: vi.fn(async () => {}) }, documents: { save: vi.fn(), saveAs: vi.fn() }, dialogs: { saveMarkdown: vi.fn() } },
  onLifecycleRequest: async (callback: typeof events.request) => { events.request = callback; return () => { events.request = null; }; },
  onLifecycleRelease: async (callback: typeof events.release) => { events.release = callback; return () => { events.release = null; }; },
  onLifecycleError: async (callback: typeof events.error) => { events.error = callback; return () => { events.error = null; }; },
}));

let root: Root;
let container: HTMLDivElement;
let activity: { draft: DraftSession | null; direct: DirectTextController | null; opening?: boolean };
let allowPrepare: boolean;
let prepared: boolean;
let requestId: number;
const report = vi.fn();
const store = { list: [], flushAll: vi.fn(async () => []) };
function Harness() {
  const lifecycle = useLifecycle(store, () => activity, report, () => allowPrepare);
  return <><main inert={lifecycle.blocked}>Workbench<button onClick={() => void lifecycle.begin("mode-switch", ["doc"])}>Navigate</button></main>{lifecycle.dialog}</>;
}
beforeEach(async () => {
  vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  activity = { draft: null, direct: null }; allowPrepare = true; prepared = false; requestId = 0;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function request(action: LifecycleRequest["action"], body: LifecycleRequest["body"] = {}) {
  if (action !== "prepare" && !prepared) {
    await request("prepare");
    vi.mocked(native.lifecycle.reply).mockClear(); store.flushAll.mockClear();
  }
  await act(async () => { events.request?.({ id: requestId++, transaction: 1, action, body }); });
  if (action === "prepare") prepared = true;
}
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find((button) => button.textContent === text);
  if (!button) throw new Error(`missing button: ${text}`);
  await act(async () => { button.click(); });
}
async function draft(valid = true, failApply = false) {
  const snapshot = { docId: "doc", revision: 0, text: "Original." };
  let lease: DraftLease | null = null;
  const port: DraftPort = {
    snapshot: async () => snapshot,
    info: async () => lease,
    acquire: async (docId, opening) => { lease = { docId, opening, token: "token", ownerWindow: "owner", generation: 0, text: opening.openingText, valid: false }; return lease; },
    update: async (_docId, _token, update) => { if (!lease) throw new Error("no lease"); lease = { ...lease, ...update }; return lease; },
    release: vi.fn(async () => { lease = null; }),
    apply: vi.fn(async () => { if (failApply) throw new Error("stale Apply rejected"); lease = null; }),
    watch: () => () => {},
  };
  const map = createSourceMap(snapshot);
  const session = await DraftSession.open(map, map.blocks[0]!, "source", port, () => ({ valid, diagnostics: valid ? [] : ["invalid draft"] }));
  await session.settle();
  activity.draft = session;
  return { session, port, get lease() { return lease!; } };
}

it("freezes and flushes before reporting view ownership, then releases on Cancel", async () => {
  await request("prepare");
  expect(store.flushAll).toHaveBeenCalledOnce();
  expect(container.querySelector("main")?.hasAttribute("inert")).toBe(true);
  expect(native.lifecycle.reply).toHaveBeenCalledWith(0, []);
  await act(async () => { events.release?.(1); });
  expect(container.querySelector("main")?.hasAttribute("inert")).toBe(false);
});

it("a post-commit recovery warning remains visible until explicitly dismissed", async () => {
  await act(async () => { events.error?.("The action completed, but recovery could not be updated"); });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("recovery could not be updated");
  await request("prepare");
  await act(async () => { events.release?.(1); });
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  await click("Dismiss");
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("late release and completion from an older transition cannot unfreeze a newer one", async () => {
  let finish!: (allowed: boolean) => void;
  vi.mocked(native.lifecycle.begin).mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  await click("Navigate");
  await request("prepare");
  await act(async () => { events.release?.(1); });
  expect(container.querySelector("main")?.hasAttribute("inert")).toBe(true);
  await act(async () => { events.request?.({ id: 2, transaction: 2, action: "prepare", body: {} }); });
  await act(async () => { finish(true); events.release?.(1); });
  expect(container.querySelector("main")?.hasAttribute("inert")).toBe(true);
  await act(async () => { events.release?.(2); });
  expect(container.querySelector("main")?.hasAttribute("inert")).toBe(false);
  await act(async () => { events.request?.({ id: 3, transaction: 1, action: "prepare", body: {} }); });
  expect(container.querySelector("main")?.hasAttribute("inert")).toBe(false);
  expect(native.lifecycle.reply).toHaveBeenCalledWith(3, null, expect.stringContaining("expired"));
});

it("fails preparation visibly while another dialog or editor acquisition is unresolved", async () => {
  allowPrepare = false;
  await request("prepare");
  expect(store.flushAll).not.toHaveBeenCalled();
  expect(native.lifecycle.reply).toHaveBeenCalledWith(0, null, expect.stringContaining("existing dialog"));
  expect(report).toHaveBeenCalled();
});

it("retained direct text prevents navigation from silently dropping it", async () => {
  const map = createSourceMap({ docId: "doc", revision: 0, text: "# Heading" });
  const direct = new DirectTextController(map, map.blocks[0]!.node.children[0]!, { applyLocalizedEdit: async () => {}, captureSourceSnapshot: async () => map.snapshot });
  direct.input(""); await direct.settle();
  activity.direct = direct;
  await request("prepare");
  expect(store.flushAll).not.toHaveBeenCalled();
  expect(native.lifecycle.reply).toHaveBeenCalledWith(0, null, expect.stringContaining("retained direct edit"));
  expect(direct.hasPending).toBe(true);
});

it("stages a clean draft discard and closes it only after native commit", async () => {
  const h = await draft();
  await request("resolve-draft", { trigger: "quit", lease: h.lease });
  expect(native.lifecycle.reply).toHaveBeenCalledWith(1, "discard");
  expect(h.session.closed).toBe(false);
  expect(h.port.release).not.toHaveBeenCalled();
  await request("discard-draft", { docId: "doc", token: "wrong-token" });
  expect(h.session.closed).toBe(false);
  await request("discard-draft", { docId: "doc", token: "token" });
  expect(h.session.closed).toBe(true);
});

it("blocks invalid Apply and Cancel preserves the real CM draft and history", async () => {
  const h = await draft(false);
  h.session.replaceText("local draft"); await h.session.settle();
  await request("resolve-draft", { trigger: "quit", lease: h.lease });
  expect([...container.querySelectorAll("button")].find((button) => button.textContent === "Apply")?.disabled).toBe(true);
  await click("Cancel");
  expect(native.lifecycle.reply).toHaveBeenCalledWith(1, "cancel");
  expect(h.session.closed).toBe(false);
  expect(h.session.text).toBe("local draft");
  expect(h.session.undo()).toBe(true);
  expect(h.session.text).toBe("Original.");
});

it("failed owner Apply stays in the resolution dialog with all draft text retained", async () => {
  const h = await draft(true, true);
  h.session.replaceText("local draft"); await h.session.settle();
  await request("resolve-draft", { trigger: "mode-switch", lease: h.lease });
  await click("Apply");
  expect(container.textContent).toContain("stale Apply rejected");
  expect(native.lifecycle.reply).not.toHaveBeenCalled();
  expect(h.session.text).toBe("local draft");
  expect(h.session.closed).toBe(false);
  await click("Cancel");
  expect(native.lifecycle.reply).toHaveBeenCalledWith(1, "cancel");
});

it("valid owner Apply uses the actual session and acknowledges only after it closes", async () => {
  const h = await draft();
  h.session.replaceText("applied draft"); await h.session.settle();
  await request("resolve-draft", { trigger: "tab-switch", lease: h.lease });
  await click("Apply");
  expect(h.port.apply).toHaveBeenCalledOnce();
  expect(h.session.closed).toBe(true);
  expect(native.lifecycle.reply).toHaveBeenCalledWith(1, "applied");
});

it("failed Save retains the same prompt and permits retry, without acknowledging resolution", async () => {
  vi.mocked(native.documents.save).mockResolvedValueOnce({ ok: false, revision: null, reason: "io-error", message: "disk unavailable" }).mockResolvedValueOnce({ ok: true, revision: null, reason: null, message: null });
  await request("resolve-canonical", { trigger: "quit", snapshot: { docId: "doc", path: "/test.md", content: "text", revision: 1, dirty: true, bom: false, newline: "lf", savedContentHash: null, savedDiskRevision: null, diskRevision: null, draftActive: null }, summary: ["/test.md", "/other.md"] });
  await click("Save");
  expect(container.textContent).toContain("disk unavailable");
  expect(container.textContent).toContain("/other.md");
  expect(native.lifecycle.reply).not.toHaveBeenCalled();
  await click("Save");
  expect(native.lifecycle.reply).toHaveBeenCalledWith(1, "saved");
});

it("an ownerless recovered draft cannot Apply blindly and remains available on Cancel", async () => {
  const h = await draft();
  const orphan = { ...h.lease, ownerWindow: null, text: "recovered draft" };
  await request("resolve-draft", { trigger: "quit", lease: orphan });
  expect(container.querySelector("textarea")?.value).toBe("recovered draft");
  expect([...container.querySelectorAll("button")].find((button) => button.textContent === "Apply")?.disabled).toBe(true);
  await click("Cancel");
  expect(h.port.apply).not.toHaveBeenCalled();
  expect(native.lifecycle.reply).toHaveBeenCalledWith(1, "cancel");
});

it("canceling the Save As picker leaves canonical resolution open until explicit Cancel", async () => {
  vi.mocked(native.dialogs.saveMarkdown).mockResolvedValueOnce(null);
  await request("resolve-canonical", { trigger: "quit", snapshot: { docId: "doc", path: null, content: "text", revision: 1, dirty: true, bom: false, newline: "lf", savedContentHash: null, savedDiskRevision: null, diskRevision: null, draftActive: null } });
  await click("Save");
  expect(container.textContent).toContain("Save dialog canceled");
  expect(native.documents.saveAs).not.toHaveBeenCalled();
  expect(native.lifecycle.reply).not.toHaveBeenCalled();
  await click("Cancel");
  expect(native.lifecycle.reply).toHaveBeenCalledWith(1, "cancel");
});

it("an in-flight image/import activity prevents close preparation without flushing past it", async () => {
  activity.opening = true;
  await request("prepare");
  expect(store.flushAll).not.toHaveBeenCalled();
  expect(native.lifecycle.reply).toHaveBeenCalledWith(0, null, expect.stringContaining("edit is still in progress"));
  expect(report).toHaveBeenCalled();
  await act(async () => { events.release?.(1); });
  activity.opening = false;
  await act(async () => { events.request?.({ id: 10, transaction: 2, action: "prepare", body: {} }); });
  expect(store.flushAll).toHaveBeenCalledOnce();
  expect(native.lifecycle.reply).toHaveBeenCalledWith(10, []);
});
