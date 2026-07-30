#!/usr/bin/env bash
# Kill-protocol step 1 (duplicates only): post the `<details>`-wrapped body of the closing duplicate
# #N onto the surviving issue #M, from `<scratch>/dup-comment.md`.
#
# usage: post-duplicate-comment.sh <N> <M>
#
# Re-derives the §SP namespace with `kp_scratch_path` — the NON-resetting read, deliberately not
# `kp_scratch_open`, which would delete the dup-comment.md this call came to send (#3718).
#
# Extracted from triage/close-not-planned.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

[ "$#" -ge 2 ] || { echo "usage: post-duplicate-comment.sh <N> <M>" >&2; exit 2; }
N="$1"; M="$2"
REPO="$(kp_repo)" || exit 1
RUN_SCRATCH="$(kp_scratch_path "triage-close-$N")" || exit 1

[ -s "$RUN_SCRATCH/dup-comment.md" ] || {
  echo "triage: §SP — $RUN_SCRATCH/dup-comment.md is missing/empty; refusing to post an empty preservation comment on #$M." >&2; exit 1; }
gh api "repos/$REPO/issues/$M/comments" -f body="$(cat "$RUN_SCRATCH/dup-comment.md")"
