#!/usr/bin/env bash
# The failed job's FULL log, for when `--log-failed` returned nothing. Grep/scope it to the failed
# step's output yourself — the taxonomy match needs the actual log body, never step names alone.
#
# usage: job-log.sh <failed-job-databaseId>
#
# Extracted from heal-ci/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "heal-ci: job-log.sh needs a job databaseId — no log body read."; echo "usage: job-log.sh <failed-job-databaseId>" >&2; exit 2; }
JOB="$1"
REPO="$(kp_repo)" || { echo "heal-ci: target repo unresolved — no log body read (UNKNOWN)."; exit 1; }

gh api "repos/$REPO/actions/jobs/$JOB/logs" || {
	echo "heal-ci: could not read job $JOB's log — UNKNOWN, and you cannot match the taxonomy without a log body."
	exit 1
}
