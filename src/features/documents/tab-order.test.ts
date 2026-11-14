import { expect, it } from "vitest";
import { closeTargets, moveTab, toggleTabPin } from "./tab-order";

it("reorders within each group and keeps relative order when pinning and unpinning", () => {
  const initial = ["a", "b", "c", "d"].map((docId) => ({ docId, pinned: false }));
  const pins = toggleTabPin(toggleTabPin(initial, "b"), "d");
  expect(pins.map((tab) => tab.docId)).toEqual(["b", "d", "a", "c"]);
  expect(moveTab(pins, "a", "d")).toBe(pins);
  const reordered = moveTab(moveTab(pins, "d", "b"), "a", "c");
  expect(reordered.map((tab) => tab.docId)).toEqual(["d", "b", "c", "a"]);
  expect(closeTargets(reordered, "b", "right")).toEqual(["c", "a"]);
  expect(closeTargets(reordered, "b", "close")).toEqual(["b"]);
  const unpinned = toggleTabPin(reordered, "d");
  expect(unpinned.map((tab) => tab.docId)).toEqual(["b", "d", "c", "a"]);
  expect(unpinned[1]?.pinned).toBe(false);
  expect(closeTargets(unpinned, "gone", "all")).toEqual([]);
});
