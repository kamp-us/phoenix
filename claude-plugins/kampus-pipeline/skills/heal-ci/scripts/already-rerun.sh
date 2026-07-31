#!/usr/bin/env bash
# The two facts the stateless one-rerun guard reads: the run's own attempt count, and how many prior
# `heal-ci: … rerun queued` markers sit on the PR.
#
# usage: already-rerun.sh <run-id> [pr]
#
# Prints `attempt=<n> rerun-markers=<n>` (markers=n/a with no PR). It DERIVES NOTHING: the one-rerun
# rule is a decision and it stays in the skill's prose, which is the canonical statement (ADR 0228 —
# a script relays, it never derives the decision).
#
# FAIL-CLOSED, and this one matters: the caller reads `attempt=1 rerun-markers=0` as "not yet rerun,
# so rerun it". A read that could not run must therefore never arrive as a zero — it exits non-zero
# with its own line on stdout, and the prose reads the status before the numbers (§ZS / ADR 0092).
#
# Extracted from heal-ci/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "heal-ci: already-rerun.sh needs a run id — the guard did NOT run (UNKNOWN, never 'not yet rerun')."; echo "usage: already-rerun.sh <run-id> [pr]" >&2; exit 2; }
RUN="$1"
PR="${2:-}"

# 1) the run's own attempt count: a rerun bumps `attempt` to 2+
ATTEMPT=$(gh run view "$RUN" --json attempt --jq '.attempt')
[ -n "$ATTEMPT" ] || { echo "heal-ci: could not read run $RUN's attempt count — UNKNOWN, never 'not yet rerun'."; exit 1; }

MARKERS="n/a"
if [ -n "$PR" ]; then
	REPO="$(kp_repo)" || { echo "heal-ci: target repo unresolved — the PR rerun-marker count did NOT run (UNKNOWN)."; exit 1; }
	# 2) a prior heal-ci rerun marker on the PR (if this is a PR run)
	MARKERS=$(gh api "repos/$REPO/issues/$PR/comments" --jq \
		'[.[] | select(.body | test("heal-ci:.*rerun queued"))] | length')
	[ -n "$MARKERS" ] || { echo "heal-ci: could not read PR #$PR's comments — the marker count is UNKNOWN, never 0."; exit 1; }
fi

printf 'attempt=%s rerun-markers=%s\n' "$ATTEMPT" "$MARKERS"
