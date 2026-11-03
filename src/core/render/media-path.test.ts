import { safeUrl, classifyUrl } from "./url-policy";
import { expect, it } from "vitest";
import { portableMediaUri, resolveMediaPath } from "./media-path";
it("resolves Unix and Windows document-relative images with one decoding pass", () => {
  expect(resolveMediaPath("../images/a%20b.png", "/notes/sub/a.md")).toBe("/notes/images/a b.png");
  expect(resolveMediaPath("images/a%20b.png", "C:\\notes\\東京.md")).toBe("C:/notes/images/a b.png");
  expect(resolveMediaPath("/images/a.png", "C:\\notes\\a.md")).toBe("C:/images/a.png");
  expect(resolveMediaPath("a%2520b.png", "/notes/a.md")).toBe("/notes/a%20b.png");
  expect(resolveMediaPath("a.png", "\\\\?\\C:\\notes\\a.md")).toBe("C:/notes/a.png");
});
it("rejects network roots, malformed escapes and control characters", () => {
  for (const ref of ["//server/a.png", "\\\\server\\a.png", "%00.png", "%ZZ.png"]) expect(resolveMediaPath(ref, "/notes/a.md")).toBeNull();
  expect(resolveMediaPath("a.png", "\\\\server\\notes\\a.md")).toBeNull();
});
it("delegates native URL spelling to the runtime converter", () => {
  expect(portableMediaUri("C:/a b.png", (path, scheme) => `${scheme}:${encodeURIComponent(path)}`)).toBe("local-media:C%3A%2Fa%20b.png");
  expect(portableMediaUri("/a b.png")).toBe("local-media://localhost/a%20b.png");
});

it("keeps WebView2 custom-protocol images through the reader URL filter", () => {
  const uri = "http://local-media.localhost/C%3A%5Cnotes%5Ca.png";
  expect(classifyUrl(uri)).toBe("localMedia");
  expect(safeUrl(uri, "image")).toBe(uri);
  expect(safeUrl(uri, "link")).toBe("");
  for (const unsafe of ["https://local-media.localhost.evil/a", "http://local-media.localhost:80/a", "http://local-media.localhost@evil/a", "https://remote.invalid/a.png"]) expect(safeUrl(unsafe, "image")).toBe("");
});
