#!/usr/bin/env bash
# The IN-FLIGHT set: every `NNNN` claimed by an open PR that ADDS a `.decisions/NNNN-*.md` file. One
# number per line, unsorted (the caller takes the max of this and the merged set).
#
# usage: claimed-numbers.sh
#
# `--paginate` plus a STREAMING `--jq` is load-bearing: a >100-file PR that adds `.decisions/NNNN` past
# file #100 still claims its number (the API caps per_page at 100; #725). REST only — the org's
# Projects-classic integration breaks GraphQL.
#
# FAIL CLOSED (ADR 0074, ADR 0059's fail-closed acquire): if the in-flight query errors, this exits
# NON-ZERO with its own line on stdout, because the caller reads an empty in-flight set as "nothing
# reserved" and would silently fall back to the on-disk-only number — the exact stale-on-disk bug the
# reservation lock exists to remove. An empty set on exit 0 legitimately means no open ADR PR.
#
# Extracted from adr/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

REPO="$(kp_repo)" || { echo "adr: target repo unresolved — the in-flight set was NOT read (UNKNOWN, never 'nothing reserved')."; exit 1; }

OPEN_PRS="$(gh api "repos/$REPO/pulls?state=open&per_page=100" --jq '.[].number')" ||
	{ echo "adr: could not enumerate open PRs — the in-flight set is UNKNOWN, never 'nothing reserved'. Re-run; do NOT fall back to the on-disk number."; exit 1; }

for PR in $OPEN_PRS; do
	gh api --paginate "repos/$REPO/pulls/$PR/files?per_page=100" \
		--jq '.[] | select(.status=="added") | .filename
              | capture("^\\.decisions/(?<n>[0-9]{4})-") | .n' ||
		{ echo "adr: could not read PR #$PR's file list — the in-flight set is INCOMPLETE, so it is UNKNOWN. Re-run; do NOT fall back to the on-disk number."; exit 1; }
done
