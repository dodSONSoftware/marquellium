/** Raw dialect parsing, before any reader transform can remove source nodes. */
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";

export const markdownSyntaxPlugins = [remarkGfm, remarkMath, remarkFrontmatter] as const;

export function createMarkdownParser() {
  return unified()
    .use(remarkParse)
    .use([...markdownSyntaxPlugins]);
}
