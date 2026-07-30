#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2016
# Step R2: fetch, prove the PR's linked issue is MINE, then switch to the head branch and rebase.
#
# Extracted VERBATIM from write-code/SKILL.md's Step R2 fenced block (epic #4435 phase 1, #4449).
# A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2 (#1929).
#
# SOURCED, never executed: `claim_is_mine` and `wt_preflight` are defined in the sourcing shell, and
# the `cd` that `wt_preflight` performs must persist for the rebase and the R3 push. Sets NO shell
# options; no EXIT trap (#4476, class #4479).
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

# The one seam this move needed: the block's `<the PR's head branch>` metavariable was substituted by
# whoever ran the step (the comment on that line names the read that yields it), so the sourcing site
# passes it instead. Fail closed on an absent one — a bare `git switch` with no ref is a usage error,
# but the guarded ops after it would still run against whatever branch the tree is on.
HEAD_BRANCH="${1:-}"
if [ -z "$HEAD_BRANCH" ]; then
  printf 'write-code Step R2: no head branch — source this as `. "$WRITECODE_SCRIPTS/stepR2-branch-rebase.sh" <the PR'"'"'s head branch>` (gh api .../pulls/$PR --jq '"'"'.head.ref'"'"'). NOTHING was switched or rebased.\n' >&2
  return 1
fi
git fetch origin
# mis-attribution guard (Step 3.5): confirm the PR's linked issue #N is MINE before touching its
# branch — so a mis-dispatched repair never pushes to another agent's live PR (the #1404 class).
# In orchestrated repair the original claim token is threaded as MY_CLAIM (ADR 0115 §3 delegated own).
claim_is_mine "$N" || { echo "refusing to repair PR #$PR — its linked issue #$N is not my claim (Step 3.5)"; exit 1; }
wt_preflight && git switch "$HEAD_BRANCH"   # gate the branch switch ([per-mutation preflight]); gh api .../pulls/$PR --jq '.head.ref'
wt_preflight && git rebase origin/main   # freshen the dispatch-time base FIRST — surface a textual conflict now, in-context (see below)
# apply the fixes addressing exactly the enumerated findings
