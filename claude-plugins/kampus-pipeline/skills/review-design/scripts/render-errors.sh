#!/usr/bin/env bash
# Print the per-surface render errors of one kind out of the capture JSON, as `<surface>: <text>`
# rows: `pageerror` rows are the deterministic #2594 hard-FAIL set, `console.error` rows are
# advisory.
#
# usage: render-errors.sh pageerror|console.error < <capture-json>
#
# Extracted from review-design/SKILL.md (#4453, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail

[ "$#" -ge 1 ] || { echo "usage: render-errors.sh pageerror|console.error < <capture-json>" >&2; exit 2; }
KIND="$1"
case "$KIND" in
	pageerror|console.error) ;;
	*) echo "render-errors.sh: kind must be pageerror or console.error" >&2; exit 2 ;;
esac

CAPTURES="$(cat)"
printf '%s' "$CAPTURES" | jq -r --arg kind "$KIND" '
  [ .[] | . as $r | $r.pageErrors[]? | select(.kind==$kind)
    | "\($r.surface): \(.text)" ] | .[]'
