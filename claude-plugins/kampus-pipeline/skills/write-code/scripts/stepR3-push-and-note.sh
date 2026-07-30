#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2016
# Step R3: re-assert the claim, force-with-lease the rebased head through `verified-push`, and post
# the format-3 repair note.
#
# Extracted VERBATIM from write-code/SKILL.md's Step R3 fenced block (epic #4435 phase 1, #4449).
# A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2 (#1929) — the
# hand-rolled $RUN_SCRATCH derivation duplicates `kp_scratch_path` (shared/lib/common.sh), and
# collapsing it onto that helper is phase 2's call.
#
# SOURCED, never executed: it reads the $N / $PR / $WT and the `claim_is_mine` + `wt_preflight`
# functions the earlier steps left in this shell. WRITE "$RUN_SCRATCH/repair-progress.md" BEFORE
# sourcing this. Sets NO shell options; no EXIT trap (#4476, class #4479).
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/bin/pipeline-cli"
# re-assert the mis-attribution guard (Step 3.5) before the resubmit push — a between-calls cwd
# reset can't move the claim, but the guard is MANDATED before every number-targeting mutation,
# exactly as wt_preflight is before every git op; gate both the push and the progress comment.
claim_is_mine "$N" || { echo "refusing to push/comment — PR #$PR linked issue #$N not my claim (Step 3.5)"; exit 1; }
# The SANCTIONED push path ([Pushing: the verdict is the ref, not the exit code]) — force-with-lease
# because the R2 rebase onto origin/main moved the head. It confirms the remote ref carries the
# rebased head before you claim the resubmit landed; exit 0 = MOVED, 1 = NOT-MOVED, 3 = UNKNOWN.
# STOP on either non-zero: a reviewer waiting on a moved head would otherwise re-gate the STALE one.
wt_preflight && "$PCLI" verified-push --cwd "$WT" --remote origin --force-with-lease \
  || { echo "write-code: the repair push was NOT confirmed on the remote (see the PUSH-VERDICT line above) — the gate would re-run against the STALE head. Do not report the resubmit as landed." >&2; exit 1; }
# compose the repair note under the §SP per-run scratch namespace, never a fixed /tmp leaf:
# concurrent repair lanes clobber a shared name and this posts THEIR note onto your issue (#3718).
# Session-keyed and deterministic, so the note you wrote in an earlier Bash call is still here.
RUN_SCRATCH="${TMPDIR:-/tmp}/kampus-run/${CLAUDE_CODE_SESSION_ID:?§SP: session id unset (#3718)}/write-code-$N"
mkdir -p "$RUN_SCRATCH" || { echo "write-code: §SP could not create a per-run scratch dir (#3718)." >&2; exit 1; }
# …write the format-3 repair note to "$RUN_SCRATCH/repair-progress.md" first, then:
[ -s "$RUN_SCRATCH/repair-progress.md" ] || { echo "write-code: repair-progress.md is missing/empty — refusing to post an empty comment." >&2; exit 1; }
gh api repos/$REPO/issues/$N/comments -f body="$(cat "$RUN_SCRATCH/repair-progress.md")"
