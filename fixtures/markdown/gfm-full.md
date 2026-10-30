# GitHub Flavored Markdown — Full Exercise

This fixture exercises every GFM construct the renderer must handle (FR-020).

## Tables

| Left aligned | Center      | Right aligned |
|:-------------|:----------:|--------------:|
| Alpha        | Beta        | 1             |
| Gamma | Delta | 2 |
| `code in cell` | [link](https://example.com) | 3 |

### Table with escaped pipes

| Cell with \| pipe | Cell with `` `\|` `` in code |
|-------------------|------------------------------|
| a \| b            | c \| d                       |

## Task lists

- [x] Implement M0 architecture
- [ ] Validate M3V fidelity gate
- [ ] Ship M5 release
  - [ ] Nested task item
  - [x] Nested completed item

## Strikethrough and emphasis

This is ~~deleted text~~ and this is **bold**, *italic*, ***bold italic***,
and _underscore italic_ with ~~bold struck***out*** mixed.

## Autolinks and links

Visit https://example.com directly, or the <https://mail.example> angle form,
or an email: user@example.com. Reference-style link: [example][ref].

Inline links: [Example](https://example.com) with *emphasis* inside [link text](https://example.org).

[ref]: https://example.com/reference "Example reference"

## Footnotes

Here is a statement with a footnote.[^1] And another.[^2]

[^1]: The first footnote, with **formatting** allowed.
[^2]: The second footnote.

## Nested lists

1. First ordered item
   1. Nested ordered
   2. Second nested
      - Mixed bullet inside ordered
      - Another
2. Second top-level
3. Third top-level

- Bullet A
  - Sub A
    - Sub-sub A
- Bullet B
- Bullet C

## Blockquotes with nesting

> A simple quote.
>
> > A nested quote with *emphasis* and `code`.
> >
> > > A triple-nested quote.
>
> The quote continues with a list:
>
> - item one
> - item two

## Code fences

```js
function greet(name) {
  // template literal with ${interpolation} and backticks
  const msg = `hello, ${name}!`;
  return msg;
}
greet("world");
```

```python
def fib(n: int) -> int:
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)
```

````
```
A fence inside a fence (four backticks).
```
````

No language:

    indented code block, four spaces
    line two

Inline `code with spaces` and `pipe | char` and a `unicode ünïcödé`.

## Autolink edge cases

- www.example.com (autolinks in GFM 1.0 → http://www.example.com)
- example.com (does NOT autolink: no scheme, no www)
- https://example.com/path?query=1#frag (autolinks)
- https://example.com/no-trailing (autolinks)
- not a link: http:// (no)

## Horizontal rules

---

***

___

End of GFM fixture.
