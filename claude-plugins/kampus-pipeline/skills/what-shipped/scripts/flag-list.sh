#!/usr/bin/env bash
# Print the authoritative Flagship state — every flag × env with its enabled/default value
# (ADR 0081/0123). In-repo first, published fallback: the same shim idiom the ship-digest call uses.
#
# Extracted from what-shipped/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail

if [ -f packages/anka-ops/src/bin.ts ]; then
  node packages/anka-ops/src/bin.ts flag list
else
  pnpm dlx @kampus/anka-ops@0.1.0 flag list
fi
