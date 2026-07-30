#!/usr/bin/env bash
# Print the `web` preview-deploy URL for the PR, read off the sticky `<!-- preview-deploy -->`
# comment CI posts (ADR 0088). Empty output ⇒ no preview ⇒ the gate can't run yet (a can't-gate,
# never a design FAIL).
# Extracted from review-design/SKILL.md (#4453, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: resolve-preview-url.sh <pr>" >&2; exit 2; }
PR="$1"
REPO="$(kp_repo)" || exit 1

PREVIEW_COMMENT="$(gh api "repos/$REPO/issues/$PR/comments?per_page=100" \
  --jq '[.[] | select(.body | test("<!-- preview-deploy -->"))] | last | .body // ""')"
# parse the `web` sub-line: `- **web** — Stage `pr-<n>` → <url>`
PREVIEW_URL="$(printf '%s' "$PREVIEW_COMMENT" | grep -oE 'https://[^ )]*workers\.dev' | head -n1)"

printf '%s\n' "$PREVIEW_URL"
