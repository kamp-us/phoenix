#!/usr/bin/env bash
# Step 5's pre-PR mutations: re-derive the branch live from the worktree, push it through the
# sanctioned `verified-push`, and confirm #N is this run's claim before opening a PR against it.
#
# usage: step5-push.sh <N>
#
# stdout is `WT=<root>` and `BRANCH=<name>` — the two facts the `gh pr create` that follows needs.
# Non-zero means NOTHING was pushed and #N was NOT proven mine: do not open a PR.
#
# Executed, never sourced (ADR 0232). `wt_preflight` and `claim_is_mine` used to be functions in the
# sourcing shell; they are now `step4-wt-preflight.sh` and `step3_5-claim-is-mine.sh`, executed as children,
# and the git ops are addressed at the printed worktree root with `-C`.
#
# The `gh pr create` heredoc deliberately stays in SKILL.md: it is a fill-in-the-blanks BODY TEMPLATE
# the agent authors per run, not glue.
# shellcheck disable=SC1007,SC1091,SC2015,SC2016
set -uo pipefail
# shellcheck source=../../../lib/common.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

HERE="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
[ -n "$HERE" ] || { echo "write-code Step 5: could not resolve this script's own directory — NOTHING was pushed." >&2; exit 1; }

# Fail closed on an absent number — the mis-attribution guard cannot resolve an owner for an empty
# one, and this guard exists precisely so a mis-attributed number never reaches a mutation (#1404).
N="${1:-}"
if [ -z "$N" ]; then
	printf 'write-code Step 5: no issue number — run this as `bash ./claude-plugins/kampus-pipeline/skills/write-code/scripts/step5-push.sh <N>`. NOTHING was pushed.\n' >&2
	exit 1
fi
# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="$(kp_pcli)" || exit 127
# RE-DERIVE the branch LIVE from the worktree — never a cached/shared-file value (see the
# live-derivation rule in Step 4). Step 4's $BRANCH is GONE across Bash calls; the preflight just
# resolved MY lane's tree, so the branch checked out there IS the work branch. Read it, never guess it.
WT="$(bash "$HERE/step4-wt-preflight.sh")" || { echo "write-code Step 5: the worktree preflight refused — NOTHING was pushed." >&2; exit 1; }
BRANCH="$(git -C "$WT" branch --show-current)"
if [ -z "$BRANCH" ]; then
	echo "write-code Step 5: could not re-derive branch from worktree $WT — refusing to push to a guessed/cached ref." >&2
	exit 1
fi
# The SANCTIONED push path — see [Pushing: the verdict is the ref, not the exit code]. It pushes
# AND independently confirms the remote ref, printing its verdict LAST on stdout. Exit 0 = MOVED,
# 1 = NOT-MOVED, 3 = UNKNOWN; STOP on either non-zero — never open a PR against a branch you
# cannot prove exists (an UNKNOWN is not a success). Its verdict line is a DIAGNOSTIC for this
# script's caller, so it is routed to stderr and never mixed into the two KEY=value lines below.
"$PCLI" verified-push --cwd "$WT" --remote origin --branch "$BRANCH" --set-upstream >&2 \
	|| { echo "write-code: the push was NOT confirmed on the remote (see the PUSH-VERDICT line above) — refusing to open a PR against an unproven branch." >&2; exit 1; }
# The PR opens AGAINST issue #N (Fixes #N) — gate it on the mis-attribution guard (Step 3.5): open a
# PR closing only an issue whose claim is mine, never one mis-attributed to another agent's #N.
bash "$HERE/step3_5-claim-is-mine.sh" "$N" >&2 \
	|| { echo "refusing to open a PR against #$N — not my claim (Step 3.5)" >&2; exit 1; }
printf 'WT=%s\nBRANCH=%s\n' "$WT" "$BRANCH"
