#!/usr/bin/env bash
# Point a PR at the defect `report` just filed, so write-code's fix loop can pick it up.
#
# usage: comment-filed.sh <pr> <filed-issue-number> <signature>
#
# The issue number is a REQUIRED argument, and a non-numeric one is refused: the `Filed #<N>` line must
# never post with an unresolved placeholder, which is why the skill's prose says to capture the number
# `report` returns FIRST and compose with that real number.
#
# Extracted from heal-ci/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

[ "$#" -ge 3 ] || { echo "heal-ci: comment-filed.sh needs <pr> <filed-issue-number> <signature> — NOTHING was posted."; echo "usage: comment-filed.sh <pr> <filed-issue-number> <signature>" >&2; exit 2; }
PR="$1"
N="$2"
SIGNATURE="$3"
case "$N" in
	'' | *[!0-9]*)
		echo "heal-ci: '$N' is not an issue number — refusing to post a \`Filed #<N>\` line with an unresolved placeholder. NOTHING was posted."
		exit 2
		;;
esac
REPO="$(kp_repo)" || { echo "heal-ci: target repo unresolved — NOTHING was posted."; exit 1; }

gh api "repos/$REPO/issues/$PR/comments" \
	-f body="heal-ci: CI red — $SIGNATURE. Filed #$N (needs-triage). Not merged." >/dev/null ||
	{ echo "heal-ci: the \`Filed #$N\` comment did NOT post on #$PR — write-code's fix loop has no pointer; do not report it as routed."; exit 1; }

printf 'defect: %s — filed #%s, pointed from #%s\n' "$SIGNATURE" "$N" "$PR"
