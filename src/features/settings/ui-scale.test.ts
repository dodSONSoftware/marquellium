// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { applyDisplayScales, normalizeDisplayScale } from "./ui-scale";

afterEach(() => document.documentElement.removeAttribute("style"));
it("defaults old preferences and bounds invalid values to usable sizes", () => {
  expect([undefined, NaN, Infinity, 0, 1, 75, 125, 200, 500].map(normalizeDisplayScale)).toEqual([100, 100, 100, 100, 75, 75, 125, 200, 200]);
});
it("keeps interface and document scales independent without zooming the whole page", () => {
  const style = document.documentElement.style;
  applyDisplayScales(150, undefined);
  expect(style.getPropertyValue("--ui-scale")).toBe("1.5"); expect(style.getPropertyValue("--document-scale")).toBe("1");
  applyDisplayScales(200, 125);
  expect(style.getPropertyValue("--ui-scale")).toBe("2"); expect(style.getPropertyValue("--document-scale")).toBe("1.25");
  applyDisplayScales(100, 125);
  expect(style.getPropertyValue("--ui-scale")).toBe("1"); expect(style.getPropertyValue("--document-scale")).toBe("1.25");
  expect(style.getPropertyValue("zoom")).toBe("");
});
