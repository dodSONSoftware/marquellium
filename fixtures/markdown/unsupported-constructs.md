# Unsupported / Unknown Constructs

Everything in this file is **outside** the v1 supported dialect (GFM + math +
Mermaid + frontmatter). Per §1A.2/§1B.7 (NFR-005), every construct below must
survive view switches and unrelated edits **verbatim** — rendered as protected,
explicitly source-editable blocks, never dropped or silently normalized.

## Wikilinks

See [[Another Page]] and [[Another Page|aliased text]] and a link with a block
embed: ![[Embedded File]].

## Obsidian callouts

> [!note] A note callout
> Content of the note.

> [!warning] A warning
> Watch out.

> [!tip]- Collapsible tip
> Hidden content.

## Raw HTML

<div class="fancy" data-x="1">
  <p>A raw HTML block with <b>bold</b> and <span style="color:red">color</span>.</p>
</div>

An inline tag: a <sup>superscript</sup> and a <br> break inside a paragraph.

An HTML comment:

<!-- a comment that must be preserved byte-for-byte -->

A self-closing tag on its own line:
<img src="inline-image.png" width="100" alt="x" />

## HTML-ish attributes (MDX-like, must NOT execute)

Component-like usage:

<Component prop="value">
  children
</Component>

<mdx-jsx a={1} />

## Directives / front-matter-style

% comment directive
= Document title (reStructuredText-style)
.. note::
   A RST-style directive body.

## Definition lists (non-GFM)

Term
:   Definition of the term.

Another term
:   Its definition.

## Markdown extensions we do not enable

~~strike~~ is GFM (supported). But vendor-specific:

[link to image](image.png){width=50%} (pandoc attribute)
@footnote{A pandoc-style footnote.}

## Nested weirdness

- A list item containing

  > a quote containing

  ```
  a code block containing
  <html tags> and [[wikilinks]]
  ```

End of unsupported constructs.
