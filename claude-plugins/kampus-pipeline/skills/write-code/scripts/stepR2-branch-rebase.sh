#!/usr/bin/env bash
# Step R2: fetch, prove the PR's linked issue is MINE, then switch to the head branch and rebase.
#
# usage: stepR2-branch-rebase.sh <PR> <N> <head-branch>
#
# stdout is `WT=<root>` — the worktree the switch and rebase happened in, and the tree every later
# repair git op must be addressed at. Non-zero means NOTHING was switched or rebased.
#
# Executed, never sourced (ADR 0232). `claim_is_mine` and `wt_preflight` used to be functions in the
# sourcing shell, and the `cd` wt_preflight performed had to persist into the R3 push; a child process
# cannot `cd` its caller, so the corrective move becomes the printed `WT=` and every git op below is
# addressed at it with `-C`.
# shellcheck disable=SC1007,SC1091,SC2016,SC2086
set -uo pipefail
# shellcheck source=../../../lib/common.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

HERE="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
[ -n "$HERE" ] || { echo "write-code Step R2: could not resolve this script's own directory — NOTHING was switched or rebased." >&2; exit 1; }

PR="${1:-}"
N="${2:-}"
HEAD_BRANCH="${3:-}"
if [ -z "$PR" ] || [ -z "$N" ] || [ -z "$HEAD_BRANCH" ]; then
	printf 'write-code Step R2: need the PR, its linked issue and the head branch — run this as `bash ./claude-plugins/kampus-pipeline/skills/write-code/scripts/stepR2-branch-rebase.sh <PR> <N> <head-branch>` (branch from `gh api .../pulls/$PR --jq .head.ref`, N from stepR2-linked-issue.sh). NOTHING was switched or rebased.\n' >&2
	exit 1
fi
# The switch and the rebase are git mutations, so they are gated on the per-mutation preflight —
# resolved FIRST, because both must be addressed at MY lane's tree and not at whatever the cwd names.
WT="$(bash "$HERE/step4-wt-preflight.sh")" || { echo "write-code Step R2: the worktree preflight refused — NOTHING was switched or rebased." >&2; exit 1; }
git -C "$WT" fetch origin || { echo "write-code Step R2: 'git fetch origin' failed — refusing to rebase onto a stale origin/main." >&2; exit 1; }
# mis-attribution guard (Step 3.5): confirm the PR's linked issue #N is MINE before touching its
# branch — so a mis-dispatched repair never pushes to another agent's live PR (the #1404 class).
# In orchestrated repair the original claim token is threaded as MY_CLAIM (ADR 0115 §3 delegated own).
bash "$HERE/step3_5-claim-is-mine.sh" "$N" >&2 \
	|| { echo "refusing to repair PR #$PR — its linked issue #$N is not my claim (Step 3.5)" >&2; exit 1; }
# The head branch is USUALLY still checked out in the original build lane's leftover worktree, so a
# bare `git switch` refuses and the step used to stop there with no route onward — which is what each
# repair agent then invented for itself (#4826). `kp_switch_head_branch` is that route: it classifies
# what pins the branch and either co-checks-it-out inside THIS lane or refuses with a named remedy.
kp_switch_head_branch "$WT" "$HEAD_BRANCH" \
	|| { echo "write-code Step R2: could not put $WT on '$HEAD_BRANCH' (the remedy is named above) — NOTHING was rebased." >&2; exit 1; }
# freshen the dispatch-time base FIRST — surface a textual conflict now, in-context (see repair.md).
# A CONFLICT is an expected outcome here, not a defect: the rebase stops mid-flight, so this exits
# non-zero WITHOUT printing `WT=`, and the fix is to resolve in-context and re-run — never `--abort`
# and push the stale base, which just re-buries the conflict until merge.
git -C "$WT" rebase origin/main \
	|| { echo "write-code Step R2: 'git rebase origin/main' stopped in $WT — the branch IS switched; resolve each conflicted hunk there, 'git add' them, 'git rebase --continue', then re-run this step. Do NOT 'git rebase --abort'." >&2; exit 1; }
printf 'WT=%s\n' "$WT"
# apply the fixes addressing exactly the enumerated findings
