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
# straight into, pinning the wrong head (#1807). Exits non-zero with EMPTY stdout when the namespace
# was never opened, so a caller's `.` fails loudly instead of reading the base tree.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

DIR="$(kp_scratch_path review-code-head)" || exit 1
[ -f "$DIR/head.env" ] || {
  echo "head-env.sh: no head handle at \$namespace/head.env — run materialize-head.sh first; NEVER fall back to the launched checkout's working copy (§HEAD, #793)." >&2
  exit 1
}
printf '%s\n' "$DIR/head.env"
