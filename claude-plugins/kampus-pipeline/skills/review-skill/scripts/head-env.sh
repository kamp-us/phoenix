#!/usr/bin/env bash
# Re-emit the four head values `materialize-head.sh` resolved (REVIEW_WT / PR_REF / HEAD_SHA /
# BASE_REF), so any later step recovers them after the harness resets the shell between Bash calls.
# Extracted from review-skill/SKILL.md's repeated re-source line (#4453, epic #4435 phase 1).
# Extraction contract: ../SKILL.md § The extracted scripts.
#
# usage: bash ./claude-plugins/kampus-pipeline/skills/review-skill/scripts/head-env.sh <pr>
#
# STDOUT IS THE ANSWER (ADR 0232, .patterns/skill-script-io-contract.md) — the same `KEY=value`
# lines materialize-head.sh printed, read back from this run's §SP handle.
#
# The namespace is per-run and per-session (§SP, #3718), which is what keeps a SIBLING reviewer's
# tree out of reach — the failure a `git worktree list` re-derivation on the shared
# `review-skill-head-${PR}` leaf walks straight into, pinning the wrong head's skill text (#1807).
# Exits non-zero with EMPTY stdout when the namespace was never opened: read the exit status BEFORE
# the stdout, because no answer is UNKNOWN, never a licence to read the base tree.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: head-env.sh <pr>" >&2; exit 2; }
PR="$1"

DIR="$(kp_scratch_path "review-skill-head-$PR")" || exit 1
[ -s "$DIR/wt.env" ] || {
  echo "review-skill: §SP — $DIR/wt.env missing; re-run the head-materialization step in THIS session. NEVER fall back to the launched checkout's working copy (§HEAD, #793)." >&2
  exit 1
}
cat "$DIR/wt.env"
