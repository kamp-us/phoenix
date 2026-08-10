#!/usr/bin/env bash
# Print the absolute path of the run-state handle `materialize-head.sh` wrote (PR_REF / HEAD_SHA,
# and REVIEW_WT if `--worktree` was used), so any later step re-derives it with
# `. "$(head-env.sh "$PR")"` after the harness resets the shell between Bash calls. Extracted from
# review-doc/SKILL.md's repeated re-source line (#4453, epic #4435 phase 1). Extraction contract:
# ../SKILL.md § The extracted scripts.
#
# `scratchpad file` REFUSES when the namespace was never opened in this run, so a lost handle fails
# loud instead of silently reading an empty directory — and this script exits non-zero with EMPTY
# stdout on that path, so a caller's `.` fails loudly rather than falling back to the launched
# checkout's working copy (§HEAD, #793). The status is WHICH cause fired: 5 / $KP_HEAD_HANDLE_ABSENT
# mean nothing was materialized, anything else means the resolver could not look (see
# `KP_HEAD_HANDLE_ABSENT` in ../../../lib/common.sh).
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: head-env.sh <pr>" >&2; exit 2; }
PR="$1"
# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="$(kp_pcli)" || exit 127

HEAD_ENV="$("$PCLI" scratchpad file --slug "review-doc-$PR" --name head.env)"
RC=$?
[ "$RC" -eq 0 ] || exit "$RC"   # propagate WHICH cause fired; see the review-code copy's note (#4972)
[ -s "$HEAD_ENV" ] || {
  echo "review-doc: §SP — head.env absent/empty, so nothing was materialized; re-run the materialize step in THIS session." >&2
  exit "$KP_HEAD_HANDLE_ABSENT"
}
printf '%s\n' "$HEAD_ENV"   # source it for $PR_REF / $HEAD_SHA (and $REVIEW_WT, if --worktree was used)
