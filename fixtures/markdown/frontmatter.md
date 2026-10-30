---
title: Frontmatter Fixture
author: "PRD, Team"
date: 2026-10-29
tags:
  - frontmatter
  - yaml
  - meta
draft: false
custom:
  nested:
    key: value
    list:
      - one
      - two
---

# Frontmatter Handling

The YAML block above must be **preserved as raw text** (FR-026): rendering may
show a compact metadata view or hide it by setting, but the bytes in the file
must never be reformatted or dropped — not on open, not on mode switch, not on
save.

Body paragraph after frontmatter.

## Section one

Content that follows the metadata. Links like [this](./links-images.md) must
resolve relative to the document, unaffected by frontmatter.
