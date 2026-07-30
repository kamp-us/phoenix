#!/usr/bin/env bash
# Print the head SHA the verdict binds to (ADR 0058), via the shared `pipeline-cli review-head`
# verb (#3690 / #793 / #1807) — `resolve` is REST-only (this gate reviews the preview URL, not a
# checked-out tree), fail-safe on a missing/closed/partial head.
# Extracted from review-design/SKILL.md (#4453, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: resolve-head.sh <pr>" >&2; exit 2; }
PR="$1"
PCLI="$(kp_pcli)" || exit 127

"$PCLI" review-head resolve --pr "$PR" | jq -r .headSha
