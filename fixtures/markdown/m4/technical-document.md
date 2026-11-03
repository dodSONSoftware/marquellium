---
title: M4 technical document
author: Marquellium
---

# Technical document 東京

A **bold** paragraph with *emphasis*, `inline code`, $x^2$, and [local anchor](#tasks).
A second soft line with literal \*stars\* and café 🎉.

## Tasks

- [ ] First task
- [x] Completed task
  - Nested **item**

3. Third item
4. Fourth item

> Quoted paragraph with **bold text**.
>
> Another quoted paragraph.

| Item | Notes | Amount |
|:---|:---:|---:|
| Alpha | escaped \| pipe | 10 |
| Beta | `code` | 20 |
| Empty | | 30 |

$$
\frac{a}{b} + x^2
$$

```mermaid
flowchart LR
 A[Start] --> B[Finish]
```

```rust
fn main() { println!("<inert>"); }
```

<!-- KEEP EXACT: protected neighbor -->

<div onclick="alert(1)">Protected HTML</div>

:::vendor
Protected unknown source.
:::

[[Protected Wiki Link]]

[Missing file](missing.md#anchor)
