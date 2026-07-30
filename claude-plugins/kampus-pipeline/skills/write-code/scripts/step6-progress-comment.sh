#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2016,SC2086
# Step 6: post the four-section progress comment, composed under the §SP per-run scratch namespace.
#
# Extracted VERBATIM from write-code/SKILL.md's Step 6 fenced block (epic #4435 phase 1, #4449).
# A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2 (#1929) — the
# hand-rolled $RUN_SCRATCH derivation duplicates `kp_scratch_path` (shared/lib/common.sh) and the
# `scratchpad` verb, and collapsing it onto either is phase 2's call, not this move's.
#
# SOURCED, never executed, so $RUN_SCRATCH stays visible and `claim_is_mine` (defined by
# step3_5-claim-is-mine.sh in this same shell) is reachable. WRITE "$RUN_SCRATCH/progress.md" BEFORE
# sourcing this — the path is deterministic and session-keyed, so it re-derives identically in an
# earlier Bash call. Sets NO shell options; no EXIT trap (#4476, class #4479).
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

# The one seam this move needed: the block's `<N>` metavariable was substituted by whoever ran the
# step, so the sourcing site passes it instead. Fail closed on an absent one — an empty number both
# addresses `repos/$REPO/issues//comments` and collapses the per-issue scratch leaf, so a concurrent
# lane's note could be posted from this one.
N="${1:-}"
if [ -z "$N" ]; then
  printf 'write-code Step 6: no issue number — source this as `. "$WRITECODE_SCRIPTS/step6-progress-comment.sh" <N>`. NO comment was posted.\n' >&2
  return 1
fi
# §SP: the per-run scratch namespace — deterministic + fail-closed, never a shared fallback.
# Keyed on the session id, so if you compose progress.md in one Bash call and post it in the
# next, this same line re-derives the SAME directory (a bare `mktemp -d` would hand the second
# call a new EMPTY dir and post an empty body).
RUN_SCRATCH="${TMPDIR:-/tmp}/kampus-run/${CLAUDE_CODE_SESSION_ID:?§SP: session id unset (#3718)}/write-code-$N"
mkdir -p "$RUN_SCRATCH" || {
  echo "write-code: §SP could not create a per-run scratch dir — refusing to compose a comment through a shared path (#3718)." >&2; exit 1; }
# …write the four-section comment to "$RUN_SCRATCH/progress.md", then:
[ -s "$RUN_SCRATCH/progress.md" ] || { echo "write-code: progress.md is missing/empty — refusing to post an empty comment." >&2; exit 1; }
BODY="$(cat "$RUN_SCRATCH/progress.md")"   # the four-section comment
# gate the comment on the mis-attribution guard (Step 3.5) — only comment on an issue whose claim is mine
claim_is_mine "$N" && gh api repos/$REPO/issues/$N/comments -f body="$BODY"
