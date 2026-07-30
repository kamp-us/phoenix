#!/usr/bin/env bash
# Print the PR's UI-affecting changed files (Step 0's mis-route off-ramp predicate). Three outcomes,
# not two: exit 0 + empty ⇒ no rendered surface ⇒ off-ramp; exit 0 + non-empty ⇒ a UI PR; NON-ZERO
# exit ⇒ UNKNOWN, and the caller must treat it as has-ui.
# Extracted from review-design/SKILL.md (#4453, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
#
# BECAUSE the caller reads EMPTY STDOUT as the off-ramp, every path that returns before the file list
# is resolved MUST print the $CANNOT_CLASSIFY sentinel on stdout first — non-empty stdout is what
# makes the off-ramp branch UNREACHABLE on a failure. A guard that could not run is UNKNOWN, and
# UNKNOWN is not "no rendered surface" (§ZS / ADR 0092; #4231, #4010, #4219); silently off-ramping is
# exactly what mints the unroutable phantom gate that deadlocks ship-it (#2470). The sentinel is
# double-guarded: it also exits non-zero, so a caller that checks the status refuses just as fast.
set -uo pipefail

# Defined BEFORE the source below so it survives a failed source (which leaves `kp_repo` undefined
# and trips the guard at 127).
CANNOT_CLASSIFY='CANNOT-CLASSIFY (classify-ui-surface.sh could not run ⇒ UNKNOWN ⇒ treat as has-ui: proceed and verdict, fail-closed)'
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || {
	echo "$CANNOT_CLASSIFY — no <pr> argument"
	echo "usage: classify-ui-surface.sh <pr>" >&2
	exit 2
}
PR="$1"
# Top-level assignment, never `local` — a `local REPO="$(kp_repo)"` takes `local`'s own status and
# masks the substitution's, so the guard below would never fire (the kp_repo idiom's gotcha).
REPO="$(kp_repo)" || {
	echo "$CANNOT_CLASSIFY — target repo unresolved"
	exit 1
}

# UI-affecting = the ONE live source (ship-it/SKILL.md@main's `UI_RE=` line) — the SAME predicate
# ship-it requires on and reviewer.md dispatches on, so require == dispatch == off-ramp by
# construction (#2470). The literal is the fail-closed REFERENCE, not the live decision source.
UI_RE='^apps/web/src/'
UI_EXCLUDE_RE='\.(test|spec)\.tsx?$'   # #3071: carve src-colocated test/spec out (no rendered surface); mirrors §CLASS has-docs carve-then-test — ERE has no lookahead, hence the exclude pair
UI_RAW="$(gh api "repos/$REPO/contents/claude-plugins/kampus-pipeline/skills/ship-it/SKILL.md?ref=main" -H 'Accept: application/vnd.github.raw' 2>/dev/null || true)"
UI_LIVE="$(printf '%s\n' "$UI_RAW" | grep '^UI_RE=' | head -n1 || true)"; UX_LIVE="$(printf '%s\n' "$UI_RAW" | grep '^UI_EXCLUDE_RE=' | head -n1 || true)"
if [ -n "$UI_LIVE" ]; then UI_RE="$(printf '%s' "$UI_LIVE" | sed "s/^UI_RE='//; s/'$//")"; else UI_RE='.'; fi   # unreadable ⇒ '.' ⇒ every path is UI-affecting ⇒ proceed & verdict (never silently off-ramp)
if [ -n "$UX_LIVE" ]; then UI_EXCLUDE_RE="$(printf '%s' "$UX_LIVE" | sed "s/^UI_EXCLUDE_RE='//; s/'$//")"; else UI_EXCLUDE_RE='$^'; fi   # unreadable ⇒ '$^' never-match ⇒ carve nothing ⇒ proceed & verdict (fail-closed)
UI_TOUCHED="$(gh api --paginate "repos/$REPO/pulls/$PR/files?per_page=100" \
  --jq '.[].filename' | grep -Ev "$UI_EXCLUDE_RE" | grep -E "$UI_RE" || true)"

printf '%s\n' "$UI_TOUCHED"
