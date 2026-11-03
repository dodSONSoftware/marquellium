/** Filesystem spelling only: native Rust still canonicalizes and scope-checks. */
export function resolveMediaPath(reference: string, documentPath: string): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(reference); } catch { return null; }
  if (/[\u0000-\u001f]/.test(decoded)) return null;
  const document = documentPath.replace(/\\/g, "/").replace(/^\/\/\?\//, "");
  // UNC/network paths are not implicit local image requests.
  if (document.startsWith("//") || decoded.startsWith("//") || decoded.startsWith("\\")) return null;
  const drive = /^[a-z]:\//i.exec(document)?.[0].slice(0, 2);
  if (!drive && !document.startsWith("/")) return null;
  const parent = document.endsWith("/") ? document : document.slice(0, document.lastIndexOf("/") + 1);
  const candidate = decoded.startsWith("/") ? (drive ?? "") + decoded : parent + decoded.replace(/\\/g, "/");
  const prefix = drive ?? "";
  const parts: string[] = [];
  for (const part of candidate.slice(prefix.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop(); else parts.push(part);
  }
  return prefix + "/" + parts.join("/");
}
export function portableMediaUri(path: string, convert?: (path: string, scheme: string) => string): string {
  if (convert) return convert(path, "local-media");
  return "local-media://localhost/" + path.split("/").map(encodeURIComponent).join("/").replace(/^\//, "");
}
