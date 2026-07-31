#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2016,SC2086
# Step 7: post the handoff note on the parent epic, gated on owning the CHILD (never the epic).
#
# Extracted VERBATIM from write-code/SKILL.md's Step 7 fenced block (epic #4435 phase 1, #4449).
# A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2 (#1929) — the
# hand-rolled $RUN_SCRATCH derivation duplicates `kp_scratch_path` (the plugin lib/common.sh), and
# collapsing it onto that helper is phase 2's call.
#
# SOURCED, never executed, so `claim_is_mine` (defined by step3_5-claim-is-mine.sh in this same shell)
# is reachable. WRITE "$RUN_SCRATCH/handoff.md" BEFORE sourcing this. Sets NO shell options; no EXIT
# trap (#4476, class #4479).
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

# The two seams this move needed: the block's `<N>` (the child you own) and `<EPIC>` (the parent you
# post onto) metavariables were substituted by whoever ran the step, so the sourcing site passes them
# instead. Fail closed on either being absent — an empty child number cannot be claim-verified, and an
# empty epic number addresses `repos/$REPO/issues//comments`.
N="${1:-}"
EPIC="${2:-}"
if [ -z "$N" ] || [ -z "$EPIC" ]; then
  printf 'write-code Step 7: need both numbers — source this as `. "$WRITECODE_SCRIPTS/step7-epic-handoff.sh" <N> <EPIC>`. NO handoff was posted.\n' >&2
  return 1
fi
# compose under the per-run scratch namespace (§SP), never a fixed /tmp leaf — a concurrent
# coder lane would clobber it and this posts ITS handoff onto your epic, silently (#3718).
# Deterministic (session-keyed), so writing handoff.md in one Bash call and posting it here in
# the next resolves the SAME directory — re-running `mktemp -d` would yield an empty one.
RUN_SCRATCH="${TMPDIR:-/tmp}/kampus-run/${CLAUDE_CODE_SESSION_ID:?§SP: session id unset (#3718)}/write-code-$N"
mkdir -p "$RUN_SCRATCH" || {
  echo "write-code: §SP could not create a per-run scratch dir — refusing to compose a handoff through a shared path (#3718)." >&2; exit 1; }
# …write the handoff to "$RUN_SCRATCH/handoff.md" first, then:
[ -s "$RUN_SCRATCH/handoff.md" ] || { echo "write-code: handoff.md is missing/empty — refusing to post an empty handoff." >&2; exit 1; }
BODY="$(cat "$RUN_SCRATCH/handoff.md")"   # ### Handoff: #N — <title> + the three fields
# the handoff to the parent epic is predicated on OWNING THE CHILD — gate on claim_is_mine <child>
# (Step 3.5), not the epic (which you never claim): only hand off about work whose claim is mine.
claim_is_mine "$N" && gh api repos/$REPO/issues/$EPIC/comments -f body="$BODY"
