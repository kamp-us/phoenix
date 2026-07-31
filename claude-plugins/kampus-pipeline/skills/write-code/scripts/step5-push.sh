#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2015,SC2016
# Step 5's pre-PR mutations: re-derive the branch live from the worktree, push it through the
# sanctioned `verified-push`, and confirm #N is this run's claim before opening a PR against it.
#
# Extracted VERBATIM from the FIRST HALF of write-code/SKILL.md's Step 5 fenced block (epic #4435
# phase 1, #4449). A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase
# 2 (#1929). The block's second half — the `gh pr create` heredoc — deliberately did NOT move: it is
# a fill-in-the-blanks BODY TEMPLATE whose prose the agent authors per run, so it stays in SKILL.md
# next to this file's invocation.
#
# SOURCED, never executed. $BRANCH must land in the sourcing shell exactly as the inline block left
# it, and `wt_preflight` / `claim_is_mine` are defined in that same shell — sourcing (not executing)
# is what keeps them reachable. Sets NO shell options; no EXIT trap (#4476, class #4479).
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

# The one seam this move needed: the block's `<N>` metavariable was substituted by whoever ran the
# step, so the sourcing site passes it instead. Fail closed on an absent one — `claim_is_mine ""`
# cannot resolve an owner, and this guard exists precisely so a mis-attributed number never reaches
# a mutation (#1404).
N="${1:-}"
if [ -z "$N" ]; then
  printf 'write-code Step 5: no issue number — source this as `. "$WRITECODE_SCRIPTS/step5-push.sh" <N>`. NOTHING was pushed.\n' >&2
  return 1
fi
# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/bin/pipeline-cli"
# RE-DERIVE the branch LIVE from the worktree — never a cached/shared-file value (see the
# live-derivation rule in Step 4). $BRANCH from Step 4 is GONE across Bash calls; wt_preflight
# just re-cd'd to $WT, so the checked-out branch IS the work branch. Read it, never guess it.
wt_preflight && BRANCH="$(git -C "$WT" branch --show-current)"
: "${BRANCH:?could not re-derive branch from worktree $WT — refusing to push to a guessed/cached ref}"
# The SANCTIONED push path — see [Pushing: the verdict is the ref, not the exit code]. It pushes
# AND independently confirms the remote ref, printing its verdict LAST on stdout. Exit 0 = MOVED,
# 1 = NOT-MOVED, 3 = UNKNOWN; STOP on either non-zero — never open a PR against a branch you
# cannot prove exists (an UNKNOWN is not a success).
wt_preflight && "$PCLI" verified-push --cwd "$WT" --remote origin --branch "$BRANCH" --set-upstream \
  || { echo "write-code: the push was NOT confirmed on the remote (see the PUSH-VERDICT line above) — refusing to open a PR against an unproven branch." >&2; exit 1; }
# The PR opens AGAINST issue #N (Fixes #N) — gate it on the mis-attribution guard (Step 3.5): open a
# PR closing only an issue whose claim is mine, never one mis-attributed to another agent's #N.
claim_is_mine "$N" || { echo "refusing to open a PR against #$N — not my claim (Step 3.5)"; exit 1; }
