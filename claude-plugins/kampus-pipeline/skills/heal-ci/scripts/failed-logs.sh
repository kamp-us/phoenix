#!/usr/bin/env bash
# The failed run's logs plus the job/step rollup that names which job died (and its databaseId, for
# the job-log fallback).
#
# usage: failed-logs.sh <run-id>
#
# EMPTY `--log-failed` OUTPUT IS A DOCUMENTED POSITIVE ANSWER in the caller's prose ("if it returns
# nothing … fall back to the failed job's full log"), so a read that COULD NOT RUN must not arrive as
# the same emptiness — it would send the caller down the fallback with no way to tell a bare `exit 1`
# run from a dead API. Each read therefore prints its own fail-closed line on stdout and exits
# non-zero; read the exit status before the stdout (§ZS / ADR 0092).
#
# Extracted from heal-ci/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail

[ "$#" -ge 1 ] || { echo "heal-ci: failed-logs.sh needs a run id — no logs read (UNKNOWN, not 'no failed steps')."; echo "usage: failed-logs.sh <run-id>" >&2; exit 2; }
RUN="$1"

gh run view "$RUN" --log-failed || {
	echo "heal-ci: could not read run $RUN's failed logs — UNKNOWN, NOT 'no annotated failed steps'."
	exit 1
}
# the job/step rollup, to know which job died (and its databaseId, for the fallback below)
gh run view "$RUN" --json conclusion,headBranch,jobs \
	--jq '{conclusion, headBranch, jobs: [.jobs[] | select(.conclusion=="failure") | {name, databaseId, steps: [.steps[] | select(.conclusion=="failure") | .name]}]}' || {
	echo "heal-ci: could not read run $RUN's job rollup — UNKNOWN, so no failed job databaseId is available."
	exit 1
}
