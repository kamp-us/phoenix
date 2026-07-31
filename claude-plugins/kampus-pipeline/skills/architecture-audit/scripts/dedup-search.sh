#!/usr/bin/env bash
# The two-source pre-filing dedup read for a finding: (a) the live needs-triage queue, which is
# read-after-write consistent and catches a just-filed twin, then (b) the search index, which covers
# older open issues that already left the queue.
#
# usage: dedup-search.sh <keywords>
#
# Keywords are joined with `+` here — raw spaces produce a malformed query URL.
#
# Extracted from architecture-audit/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: dedup-search.sh <keywords>" >&2; exit 2; }
KEYWORDS="$(printf '%s' "$1" | tr ' ' '+')"
REPO="$(kp_repo)" || exit 1

# (a) the live needs-triage queue — read-after-write consistent, catches a just-filed twin
gh api "repos/$REPO/issues?state=open&labels=status:needs-triage&per_page=100" \
  --jq '.[] | "#\(.number) \(.title)"'
# (b) the search index — covers older open issues that already left the queue
gh api "search/issues?q=repo:$REPO+is:issue+is:open+$KEYWORDS" \
  --jq '.items[] | "#\(.number) \(.title)"'
