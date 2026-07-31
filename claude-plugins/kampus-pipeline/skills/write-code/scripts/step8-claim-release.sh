#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2016
# Step 8: retract OUR OWN claim marker — the last mutation of the run that held it.
#
# Extracted VERBATIM from write-code/SKILL.md's "Release the claim" fenced block (epic #4435 phase 1,
# #4449). A byte-move, not a rewrite: the release line already IS the verb, so ADR 0228 keeps it a
# relay — it passes the verb's answer through and never re-derives who owns the lane. Phase 2 (#1929)
# has nothing to do here.
#
# SOURCED, never executed, so it reads the $MY_CLAIM the sourcing shell carries. Sets NO shell
# options; no EXIT trap (#4476, class #4479).
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

# The one seam this move needed: the block's `<N>` metavariable was substituted by whoever ran the
# step, so the sourcing site passes it instead. Fail closed on an absent one — `claim release` with no
# issue number releases nothing, and reporting the lane freed when it is not is how a claim outlives
# its run.
N="${1:-}"
if [ -z "$N" ]; then
  printf 'write-code Step 8: no issue number — source this as `. "$WRITECODE_SCRIPTS/step8-claim-release.sh" <N>`. The claim was NOT released.\n' >&2
  return 1
fi
# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/bin/pipeline-cli"
# the last mutation of the run — retract OUR OWN claim marker on the issue we just built.
# --session carries the token we owned the work under (the orchestrator's delegated token on the
# orchestrated path), because that is the token the marker itself carries.
"$PCLI" claim release --issue "$N" --session "$MY_CLAIM"
