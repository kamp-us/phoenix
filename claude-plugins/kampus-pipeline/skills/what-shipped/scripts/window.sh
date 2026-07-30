#!/usr/bin/env bash
# Print the readout window as `<since> <until>` (ISO dates, UTC), defaulting to the last 7 days.
# $SINCE / $UNTIL in the environment override either end.
#
# The `date -u -v-7d` / `date -u -d '7 days ago'` pair is BSD-then-GNU, in that order, because this
# runs on both macOS and CI Linux.
#
# Extracted from what-shipped/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail

SINCE="${SINCE:-$(date -u -v-7d +%Y-%m-%d 2>/dev/null || date -u -d '7 days ago' +%Y-%m-%d)}"
UNTIL="${UNTIL:-$(date -u +%Y-%m-%d)}"
[ -n "$SINCE" ] && [ -n "$UNTIL" ] || { echo "what-shipped: could not resolve the window — neither BSD nor GNU date accepted the offset." >&2; exit 1; }
echo "window: $SINCE → $UNTIL" >&2
printf '%s %s\n' "$SINCE" "$UNTIL"
