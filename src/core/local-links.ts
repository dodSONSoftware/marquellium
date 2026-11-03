import { createMarkdownParser } from "./render/parser";
import { classifyUrl } from "./render/url-policy";
import { outlineOf } from "./render/pipeline";
interface Node { type: string; url?: string; identifier?: string; children?: Node[] }
/** Includes reference links/images; never follows remote URLs. */
export function localLinks(source: string): string[] {
  const root: Node = createMarkdownParser().parse(source);
  const definitions = new Map<string, string>();
  const visit = (node: Node, fn: (node: Node) => void) => { fn(node); node.children?.forEach((child) => visit(child, fn)); };
  visit(root, (node) => { if (node.type === "definition" && node.identifier && node.url) definitions.set(node.identifier.toLowerCase(), node.url); });
  const links = new Set<string>();
  visit(root, (node) => {
    const href = node.type === "link" || node.type === "image" ? node.url : node.type === "linkReference" || node.type === "imageReference" ? definitions.get(node.identifier?.toLowerCase() ?? "") : undefined;
    if (href && ["relative", "fragment"].includes(classifyUrl(href))) links.add(href);
  });
  return [...links].slice(0, 1000);
}
export function hasAnchor(source: string, fragment: string): boolean {
  return !fragment || outlineOf(source).some((heading) => heading.slug === fragment);
}
