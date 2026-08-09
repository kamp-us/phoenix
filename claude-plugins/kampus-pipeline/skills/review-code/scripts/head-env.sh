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
# The namespace is per-run and per-session (§SP, #3718), which is what keeps a SIBLING reviewer's
# tree out of reach — the failure a `git worktree list` re-derivation on a shared leaf name walks
# straight into, pinning the wrong head (#1807). Exits non-zero with EMPTY stdout when it cannot
# print a handle, so a caller's `.` fails loudly instead of reading the base tree — and the status is
# WHICH cause fired: 5 / $KP_HEAD_HANDLE_ABSENT mean nothing was materialized, anything else means
# the resolver could not look (see `KP_HEAD_HANDLE_ABSENT` in ../../../lib/common.sh).
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

DIR="$(kp_scratch_path review-code-head)"
RC=$?
# Propagate `kp_scratch_path`'s own status instead of flattening it to 1: teardown-head.sh decides
# no-op-vs-error from this number, and a flattened 1 made "namespace never opened" (5) look the same
# as "the CLI never ran" (127) — #4972.
[ "$RC" -eq 0 ] || exit "$RC"
[ -f "$DIR/head.env" ] || {
  echo "head-env.sh: namespace $DIR holds no head.env — materialize-head.sh never ran (or was aborted) in THIS session, so nothing was materialized. NEVER fall back to the launched checkout's working copy (§HEAD, #793)." >&2
  exit "$KP_HEAD_HANDLE_ABSENT"
}
printf '%s\n' "$DIR/head.env"
