#!/usr/bin/env bash
# Print the absolute path of the run-state handle `materialize-head.sh` wrote (REVIEW_WT / PR_REF /
# HEAD_SHA / BASE_REF), so a later step re-derives those four after the harness resets the shell
# between Bash calls. Extracted from review-code/SKILL.md's repeated `. "$WT_FILE"` re-source line
# (#4451, epic #4435 phase 1). Extraction contract: ../SKILL.md § The extracted scripts.
#
# ITS CALLERS ARE THIS SKILL'S OWN SCRIPTS, never the agent's top-level command. They read it as
# `. "$(head-env.sh)"` from inside their own process, which ADR 0232 leaves sanctioned — the ban is
# on an AGENT sourcing at its top-level command, which the isolation verifier refuses. The agent
# reads the same four values off `materialize-head.sh`'s stdout instead.
#
# usage: head-env.sh <pr>
#
# The namespace is per-run, per-session AND per-PR (§SP, #3718). The PR key is load-bearing, not
# symmetry with the sibling gates: a session-only key does not discriminate at the one moment it
# has to, because the normal drain fans several `review-code` runs inside ONE session — they then
# shared a single `head.env`, the last `materialize-head.sh` won, and every earlier reviewer
# silently re-pointed at the winner's tree (#5416). Callers pass the PR they were invoked for, so
# a caller asking for PR N can never be handed a handle describing PR M — the slug separates them,
# and `kp_head_handle_names_pr` refuses the leftovers of any way one still could.
#
# Exits non-zero with EMPTY stdout when it cannot print a TRUSTWORTHY handle, so a caller's `.`
# fails loudly instead of reading the base tree — and the status is WHICH cause fired: 5 /
# $KP_HEAD_HANDLE_ABSENT mean nothing was materialized, anything else (a mismatched handle
# included) means the resolver could not hand over an answer, which is UNKNOWN (see
# `KP_HEAD_HANDLE_ABSENT` in ../../../lib/common.sh).
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: head-env.sh <pr>" >&2; exit 2; }
PR="$1"

DIR="$(kp_scratch_path "review-code-head-$PR")"
RC=$?
# Propagate `kp_scratch_path`'s own status instead of flattening it to 1: teardown-head.sh decides
# no-op-vs-error from this number, and a flattened 1 made "namespace never opened" (5) look the same
# as "the CLI never ran" (127) — #4972.
[ "$RC" -eq 0 ] || exit "$RC"
[ -f "$DIR/head.env" ] || {
  echo "head-env.sh: namespace $DIR holds no head.env — materialize-head.sh never ran for PR $PR (or was aborted) in THIS session, so nothing was materialized. NEVER fall back to the launched checkout's working copy (§HEAD, #793)." >&2
  exit "$KP_HEAD_HANDLE_ABSENT"
}
# Verify the handle DESCRIBES this PR before handing its path out. Read it in a subshell so the
# check cannot leak the handle's values into this script's own environment and answer itself.
(
  # shellcheck disable=SC1090,SC1091  # the run-unique handle resolved just above
  . "$DIR/head.env" || {
    echo "head-env.sh: $DIR/head.env exists but could not be read — unreachable is not absent." >&2
    exit 1
  }
  kp_head_handle_names_pr "$PR" "$DIR/head.env"
) || exit 1
printf '%s\n' "$DIR/head.env"
