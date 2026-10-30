# Links and Images Fixture

Local resolution rules (FR-023) and graceful missing-file behavior.

## Relative images

Adjacent assets folder:

![Architecture diagram](./assets/diagram.png)

Subfolder reference:

![Nested asset](./sub/deep/asset.png) (missing — must show accessible placeholder)

No extension:

![No extension](./assets/norext) (missing)

## Relative document links

- [GFM fixture](./gfm-full.md)
- [With anchor](./gfm-full.md#tables)
- [Deep relative](./sub/dir/doc.md) (missing)
- [Parent relative](../filesytem-link.md) (missing; also a typo'd path on purpose)
- [Unicode name](./日本語ドキュメント.md) (missing; Unicode path)

## External links (must not fetch at render time)

- [Example](https://example.com)
- [Mailto](mailto:hello@example.com)
- [Anchored](https://example.com/page#section)

## Local media policy cases

![Absolute path](/etc/hosts) (outside workspace — must be blocked, not served)
![Traversal](../../outside-workspace.png) (traversal — must be blocked)
![Tracking pixel](https://tracking.example/1px.gif) (remote — off by default, must not load)

## Anchor-only links

[jump to tables](#tables)
[jump to a unicode heading](#café)

End.
