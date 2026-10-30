#!/usr/bin/env bash
# Regenerate binary/symlink artifacts under fixtures/filesystem.
set -euo pipefail
cd "$(dirname "$0")"
ln -sf docs/guide.md workspace-a/link-to-guide.md
ln -sf docs/missing-target.md workspace-a/broken-link.md
# 1x1 red PNG
printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB\x60\x82' > workspace-a/assets/diagram.png
