# CommonMark Edge Cases

Core CommonMark behaviors that must be handled exactly (FR-020).

## Headings

# H1
## H2
### H3
#### H4
##### H5
###### H6
####### Not a heading (seven hashes)

Setext:

H1 setext
=========

H2 setext
---------

Not a setext:

    code block line
    =============   (still code, not a heading)

## Emphasis edge cases

foo **bar baz** ok
foo ***bar baz*** ok
foo _bar baz_ ok
foo ___bar baz___ ok
foo _bar baz_ ok
foo __bar __baz__ qux__ ok (intra-word underscores)
Camel**Case** is not emphasis (CommonMark rule)
a * b * c is not emphasis
**foo bar**
*foo*
_a_

## Links and images

[link](/absolute/path "title")
[link](relative/path.md)
[link](./sub/dir/file.md#anchor)
[link with spaces in url](https://example.com/some path)
[link](https://example.com "title with \"quotes\"")
![alt text](missing.png)
![broken](../../does-not-exist.png)
[]()
<https://only-this.com>

## Reference definitions

[a][b]

[b]: /url "title"

[duplicate][d1] and [d2][d1]

[d1]: /one
[d1]: /two (first definition wins)

## Paragraphs and line breaks

This paragraph has a hard break:
line one
line two (backslash break above? no, two spaces)

Another hard break via backslash:
line one\
line two

A soft break:
line one
line two (same paragraph)

## Lists with loose paragraphs

1. Item with paragraph:

   The item continues here.

2. Next item.

3. Item with code:

   ```js
   const x = 1;
   ```

## Blockquotes edge cases

>foo

This is a lazy continuation:
> quote start
lazy line in same paragraph? (no — new paragraph, not quoted)

## Code spans

`code` and `` `two backticks` `` and ``` `three ` ` ```.
`` ` `` alone is a code span with a backtick.

## Entities and Unicode (CommonMark)

&amp; &lt; &gt; &quot; &#39; &copy; &nbsp;

Raw `<b>not bold</b>` (raw HTML — must be escaped/protected, never executed).

## Nested combinations

- A list item
  containing a **bold** *emphasis* mix with `code` and a [link](https://example.com)
  and even a small quote:

  > quoted inside list

- Next item with a sub-list:
  - sub one
  - sub two with ~~strike~~ (GFM)

End.
