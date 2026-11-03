import { describe, expect, it } from "vitest";
import { restoreContext } from "./view-context";

describe("cross-mode source context", () => {
  it("preserves an exact reverse selection without editing", () => {
    expect(restoreContext({ text: "a **bold** b", anchor: 8, head: 4 }, "a **bold** b")).toEqual({ anchor: 8, head: 4 });
  });
  it("maps an unrelated preceding edit", () => {
    expect(restoreContext({ text: "one\n\ntarget", anchor: 5, head: 11 }, "longer\n\ntarget")).toEqual({ anchor: 8, head: 14 });
  });
  it("never restores inside a surrogate pair", () => {
    expect(restoreContext({ text: "😀", anchor: 1, head: 2 }, "😀")).toEqual({ anchor: 0, head: 2 });
  });
});

it("falls back safely inside combining and joined-emoji graphemes", () => {
  const text = "e\u0301 👩‍💻";
  expect(restoreContext({ text, anchor: 1, head: 5 }, text)).toEqual({ anchor: 0, head: 3 });
});
