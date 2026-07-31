#!/usr/bin/env bash
# Kill-protocol step 1 (duplicates only): open the per-run scratch namespace for the close of #N
# and fetch #N's full body into it, so the loser's content can be preserved on the survivor before
# #N is closed. Prints the scratch directory.
#
# usage: fetch-duplicate-body.sh <N>
#   writes  <scratch>/dup.md   #N's body verbatim — wrap it in <details> as <scratch>/dup-comment.md
#
# The §SP namespace is keyed on the session id, not the issue number: an issue number is NOT unique,
# and a clobbered file reads back cleanly as another run's body, preserving the WRONG original
# (#3718). post-duplicate-comment.sh re-derives this same directory through the same `kp_scratch_*`
# seam in a LATER Bash call, where every shell variable is gone.
#
# Extracted from triage/close-not-planned.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: fetch-duplicate-body.sh <N>" >&2; exit 2; }
N="$1"
REPO="$(kp_repo)" || exit 1
RUN_SCRATCH="$(kp_scratch_open "triage-close-$N")" || exit 1

gh api "repos/$REPO/issues/$N" --jq '.body' > "$RUN_SCRATCH/dup.md" || exit 1
printf '%s\n' "$RUN_SCRATCH"
