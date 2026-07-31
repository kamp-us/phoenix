#!/usr/bin/env bash
# Print the blessed surface-ids: the keys of the committed golden pointer's `surfaces` map (ADR
# 0183). The changed BLESSED surfaces are the capture surface-ids (Step 1) ∩ this list; an empty
# intersection ⇒ no blessed surface changed ⇒ the golden-deviation class is N/A (skip Step 2b).
# Extracted from review-design/SKILL.md (#4453, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail

POINTER=packages/design-capture/golden-pointer.json
BLESSED_SURFACES="$(jq -r '.surfaces | keys[]' "$POINTER" 2>/dev/null || true)"

printf '%s\n' "$BLESSED_SURFACES"
