/**
 * Read mode (FR-010): rendered Markdown with no editing controls in the
 * content area, keyboard-navigable links, selectable text.
 *
 * Rendering goes through the shared ADR-003 pipeline plugins (same remark/
 * rehype plugins as the Node golden tests and M5 exports). Security:
 *  - raw HTML arrives pre-converted to escaped marked code (pipeline),
 *  - every URL passes the single audited policy (url-policy.ts),
 *  - local media loads only through the scoped `local-media:` protocol
 *    (Rust scope-checks each request; T3),
 *  - remote images are never requested (T4) — a placeholder is shown.
 *
 * M2 scope: Mermaid and math render as *marked source fallbacks*
 * (FR-024/FR-025 render properly in M4). The outline (FR-014) is computed
 * by the shell for the left sidebar (FR-047); the DOM ids this component
 * emits come from the same slugger, so ids and TOC entries agree by
 * construction.
 */
import { MathPreview, MermaidPreview } from "./TechnicalPreview";
import { memo, useMemo, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import ReactMarkdown, { type Components } from "react-markdown";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import c from "highlight.js/lib/languages/c";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import {
  parseFrontmatter,
  readerRehypePlugins,
  readerRemarkPlugins,
} from "../../core/render/pipeline";
import { classifyUrl, safeUrl } from "../../core/render/url-policy";
import "./reader.css";
interface AnchoredNode { position?: { start?: { offset?: number } }; data?: { hProperties?: Record<string, unknown> }; children?: AnchoredNode[] }
const sourceAnchors = () => (tree: AnchoredNode) => {
  const visit = (node: AnchoredNode) => {
    if (node.position?.start?.offset !== undefined) {
      node.data ??= {}; node.data.hProperties ??= {};
      node.data.hProperties["data-source-start"] = node.position.start.offset;
    }
    node.children?.forEach(visit);
  };
  tree.children?.forEach(visit);
};
const anchoredPlugins = [...readerRemarkPlugins, sourceAnchors];


hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("shell", bash);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("c", c);
hljs.registerLanguage("css", css);
hljs.registerLanguage("go", go);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("md", markdown);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("rs", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);

const KNOWN_LANGUAGES = new Set(hljs.listLanguages());

export interface ReaderProps {
  content: string;
  /** Absolute path of the containing document (FR-023 base), or null. */
  docPath: string | null;
  /** Open a document-relative link in the app. */
  onOpenLocal: (relative: string) => void;
  /** Open an external link in the system browser. */
  onOpenExternal: (url: string) => void;
  /** Exposes the scroll container (FR-014 active-heading tracking). */
  showFrontmatter?: boolean;
  scrollRef?: (el: HTMLDivElement | null) => void;
}

function hastText(node: unknown): string {
  const n = node as { value?: string; children?: unknown[] };
  if (!n || typeof n !== "object") return "";
  if (typeof n.value === "string") return n.value;
  return (n.children ?? []).map(hastText).join("");
}

// ---------------------------------------------------------------------------
// Code blocks (FR-021, T1, FR-024/025 M2 fallbacks)
// ---------------------------------------------------------------------------

function CodeBlock({
  text,
  lang,
  dataRender,
  sourceStart,
}: {
  text: string;
  lang: string | null;
  dataRender: string | undefined;
  sourceStart?: number;
}) {
  const [copied, setCopied] = useState(false);
  if (dataRender === "math-block") return <div data-source-start={sourceStart}><MathPreview source={text} display /></div>;
  if (lang === "mermaid") return <div data-source-start={sourceStart}><MermaidPreview source={text} /></div>;

  const kind =
    dataRender === "raw-html"
      ? "raw-html"
      : dataRender === "math-block"
        ? "math"
        : lang === "mermaid"
          ? "mermaid"
          : lang && KNOWN_LANGUAGES.has(lang)
            ? "code"
            : "plain";

  let body: string;
  if (kind === "code" && lang) {
    body = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  } else {
    body = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  const copy = () => {
    const done = () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    };
    // The Tauri clipboard plugin is the reliable path in the webview;
    // the Web Clipboard API covers browser development.
    writeText(text)
      .then(done)
      .catch(() => {
        void navigator.clipboard.writeText(text).then(done).catch(() => {});
      });
  };

  const badge =
    kind === "raw-html"
      ? "Raw HTML — shown escaped, never executed"
      : kind === "math"
        ? "Math — rendered in a later milestone"
        : kind === "mermaid"
          ? "Mermaid diagram — rendered in a later milestone"
          : null;

  return (
    <div data-source-start={sourceStart} className={`codeblock kind-${kind}`}>
      {(kind === "code" || kind === "plain") && (
        <div className="codeblock-head">
          <span>{lang ?? "text"}</span>
          <button onClick={copy} aria-label="Copy code">
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}
      {badge && <div className="codeblock-badge">{badge}</div>}
      {kind === "code" ? (
        <pre>
          <code
            className={`hljs language-${lang}`}
            dangerouslySetInnerHTML={{ __html: body }}
          />
        </pre>
      ) : (
        <pre>
          <code dangerouslySetInnerHTML={{ __html: body }} />
        </pre>
      )}
      {(kind === "raw-html" || kind === "math" || kind === "mermaid") && (
        <div className="codeblock-foot">
          <button onClick={copy} aria-label="Copy source">
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

function ReaderInner({ content, docPath, onOpenLocal, onOpenExternal, scrollRef, showFrontmatter = true }: ReaderProps) {
  const frontmatter = useMemo(() => parseFrontmatter(content), [content]);

  const components: Components = useMemo(
    () => ({
      pre({ node }) {
        const n = node as { children?: unknown[] };
        const codeEl = (n.children?.[0] ?? {}) as {
          properties?: Record<string, unknown>;
        };
        const cls = codeEl.properties?.className;
        const lang =
          typeof cls === "string"
            ? /language-(\w+)/.exec(cls)?.[1] ?? null
            : Array.isArray(cls)
              ? (/language-(\w+)/.exec((cls as string[]).join(" "))?.[1] ?? null)
              : null;
        const rawStart = node?.properties?.["data-source-start"] ?? codeEl.properties?.["data-source-start"];
        const sourceStart = rawStart === undefined ? undefined : Number(rawStart);
        return (
          <CodeBlock
            text={hastText(n.children?.[0])}
            lang={lang}
            dataRender={codeEl.properties?.["data-render"] as string | undefined}
            sourceStart={sourceStart !== undefined && Number.isFinite(sourceStart) ? sourceStart : undefined}
          />
        );
      },
      code({ children, node, ...rest }) {
        if (node?.properties?.["data-render"] === "math-inline") return <MathPreview source={String(children)} />;
        // Only inline code reaches here (pre consumes fenced blocks).
        return (
          <code className="inline-code" {...rest}>
            {children}
          </code>
        );
      },
      // img: the pipeline has already resolved src to a local-media: URI or
      // replaced unsafe images with inert placeholders — nothing to decide
      // here (single policy point, ADR-003).
      a({ href, children, ...rest }) {
        // href here is already policy-safe (the pipeline dropped blocked
        // hrefs); classification drives only the click behavior.
        const kind = classifyUrl(href ?? "");
        const handle = (e: React.MouseEvent) => {
          e.preventDefault();
          if (kind === "fragment" && href?.startsWith("#")) {
            document.getElementById(href.slice(1))?.scrollIntoView({
              behavior: "smooth",
              block: "start",
            });
          } else if (kind === "relative") {
            onOpenLocal(href ?? "");
          } else if (kind === "remote" || kind === "mailto") {
            onOpenExternal(href ?? "");
          }
        };
        return (
          <a
            {...rest}
            href={href || undefined}
            onClick={handle}
            className={
              kind === "remote" || kind === "mailto" ? "ext-link" : undefined
            }
          >
            {children}
          </a>
        );
      },
    }),
    [docPath, onOpenLocal, onOpenExternal],
  );

  return (
    <div className="reader" ref={scrollRef}>
      {showFrontmatter && frontmatter && frontmatter.pairs.length > 0 && (
        <div className="frontmatter-card">
          {frontmatter.pairs.map((p) => (
            <div key={p.key} className="fm-row">
              <span className="fm-key">{p.key}</span>
              <span className="fm-value">{p.value || "—"}</span>
            </div>
          ))}
        </div>
      )}
      <ReactMarkdown
        remarkPlugins={anchoredPlugins as never}
        rehypePlugins={readerRehypePlugins(docPath) as never}
        // Second pass through the SAME audited function (the pipeline
        // already enforced it): local-media: survives, everything exotic
        // stays blocked.
        urlTransform={(url, key) => safeUrl(url, key === "src" ? "image" : "link")}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export const Reader = memo(ReaderInner);
