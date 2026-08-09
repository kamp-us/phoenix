#!/usr/bin/env bash
# Step 4's opening preflight: fail closed unless this run is in a LINKED git worktree, and stamp the
# lane so every later `step4-wt-preflight.sh` has an independently-derived operand to compare against.
#
# usage: step4-preflight.sh
#
# stdout is three `KEY=value` lines — `GITDIR=`, `COMMON=`, `WT=` — a MACHINE channel, so the scanned
# scope, the LOUD refusals and the CONFIRMED assertion all go to stderr (#4510). `WT=` is the one a
# caller acts on: EVERY later Edit/Write and git op anchors to it.
#
# Executed, never sourced (ADR 0232) — those three values used to survive into Step 4's later blocks
# through the sourcing shell, which the harness resets between an agent's Bash calls anyway. The
# *why* — why the LOUD refusal keys on the agent type, why self-provisioning is not the remedy, and
# what a pass positively establishes — stays in that step's prose (ADR 0172, #2440/#2443/#3406/#3458).
#
# FAIL-CLOSED by construction: it refuses on the primary checkout, on a not-a-repo cwd, AND on the
# ambiguous default — only positive evidence of a linked worktree lets it through, and every refusal
# prints NOTHING on stdout.
# shellcheck disable=SC1007,SC1091,SC2016
set -uo pipefail
# shellcheck source=../../../lib/common.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

# fail closed unless we're in a LINKED git worktree (not the primary checkout)
GITDIR="$(git rev-parse --absolute-git-dir 2>/dev/null)" || {
	echo "write-code preflight FAILED: not inside a git repository — refusing to mutate." >&2; exit 1; }
COMMON="$(git rev-parse --git-common-dir 2>/dev/null)"
case "$COMMON" in /*) ;; *) COMMON="$(pwd)/$COMMON" ;; esac   # normalize relative `.git` (older git)
COMMON="$(cd "$COMMON" && pwd)"

# Was worktree isolation EXPECTED for this run? The coder agent-type (agents/coder.md) asserts
# isolation UNCONDITIONALLY, so any run under it expects the harness to have provisioned a linked
# worktree + set $WORKTREE_ROOT. Three machine-checkable, harness-set signals arm it — NOT a per-run
# guess — mirroring the repo-side guard's `isIsolationExpected` (bash-pin.ts) exactly (#3406):
#   1. a direct isolation-asserting agent-type name ($CLAUDE_CODE_AGENT matching coder/reviewer/shipper);
#   2. a set $WORKTREE_ROOT (the harness signalled a provisioned root);
#   3. the ENV-INDEPENDENT corroboration — any agent-context run ($CLAUDE_CODE_AGENT non-empty) sitting
#      on the PRIMARY checkout (git-dir == common-dir). A NESTED/renamed coder spawn inherits the
#      PARENT's agent-type string (e.g. `crew-engineering-manager` / `junior-engineer`, ADR 0189), so the
#      NAME match alone goes inert for it — but such a spawn on the primary checkout is a broken/absent
#      worktree whatever its inherited name, and clause 3 catches it regardless of the string. Keying on
#      the agent-type LITERAL alone was the #3406 defect: a renamed coder computed isolation-expected=0
#      and silently self-provisioned. Do NOT hard-code any agent-type name (junior-engineer or otherwise)
#      to "fix" it — that just relocates the coupling to the next rename; the corroboration removes it.
# A genuine standalone human run (a direct `/write-code`, $CLAUDE_CODE_AGENT unset) matches NONE of the
# three, so it never over-refuses and still reaches the Non-isolated fallback. This is what lets the
# fail-closed branch below distinguish "isolation expected but the harness no-op'd provisioning" (#2440)
# from a legitimate standalone run, firing LOUD in the first case without regressing the second. See
# ADR 0172, #2462 (the guard's parallel re-keying), and #3406.
CLAUDE_CODE_AGENT="${CLAUDE_CODE_AGENT:-}"
WORKTREE_ROOT="${WORKTREE_ROOT:-}"
ISOLATION_EXPECTED=0
case "$CLAUDE_CODE_AGENT" in *coder*|*reviewer*|*shipper*) ISOLATION_EXPECTED=1 ;; esac   # direct isolation-asserting agent-type name
[ -n "$WORKTREE_ROOT" ] && ISOLATION_EXPECTED=1                            # harness signalled a provisioned root
# env-independent corroboration: a non-empty agent-type on the PRIMARY checkout (git-dir == common-dir) —
# catches a nested/renamed coder whose inherited agent-type string doesn't name a role (#3406).
[ -n "$CLAUDE_CODE_AGENT" ] && [ "$GITDIR" = "$COMMON" ] && ISOLATION_EXPECTED=1
echo "write-code preflight: git-dir=$GITDIR common-dir=$COMMON cwd=$(pwd) isolation-expected=$ISOLATION_EXPECTED (agent=${CLAUDE_CODE_AGENT:-unset} worktree-root=${WORKTREE_ROOT:+set})" >&2   # emit scanned scope (ADR 0092 §1)
if [ "$GITDIR" = "$COMMON" ]; then
	if [ "$ISOLATION_EXPECTED" = 1 ]; then
		# FAIL-CLOSED LOUD (the #2443 branch): isolation was EXPECTED but this run is on the PRIMARY
		# checkout with no linked worktree — the harness's `git worktree add` + $WORKTREE_ROOT injection
		# silently didn't run for this coder spawn (#2440's harness no-op). Because the whole repo-side
		# worktree-guard keys on $WORKTREE_ROOT, that no-op ALSO disarmed it, leaving this preflight the
		# sole surviving layer. Do NOT self-provision here: doing so papers over the harness failure and
		# leaves the two-layer primary-corruption defense collapsed to one, invisibly (#2270 class).
		echo "write-code preflight FAILED (fail-closed, LOUD): worktree isolation was EXPECTED (agent=${CLAUDE_CODE_AGENT:-?}, worktree-root=${WORKTREE_ROOT:+set}) but this run is on the PRIMARY checkout (git-dir == common-dir) and \$WORKTREE_ROOT is unset." >&2
		echo "  ROOT CAUSE: the harness's worktree provisioning (git worktree add + \$WORKTREE_ROOT injection) did NOT run for this coder spawn — the #2440 harness no-op. The repo-side worktree-guard also keys on \$WORKTREE_ROOT, so it is disarmed too; only this preflight is left." >&2
		echo "  REFUSING to self-provision — that would hide the harness failure and leave the two-layer defense collapsed to one, invisibly (the primary-checkout-corruption class, #2270)." >&2
		echo "  ROUTED BLOCKER — surface UP to the operator/EM: 'harness worktree provisioning no-op'd for a coder spawn (isolation expected, \$WORKTREE_ROOT unset); the out-of-repo harness half (#2440) needs attention. Do NOT blindly retry the same spawn.'" >&2
		exit 1
	fi
	# isolation was NOT expected ⇒ a genuine standalone run: fall through to the Non-isolated fallback,
	# which self-provisions a worktree (this path is unchanged, and the loud branch above never fires for it).
	echo "write-code preflight FAILED (fail-closed): git-dir == common-dir ⇒ this is the PRIMARY checkout, not an isolated worktree." >&2
	echo "  Refusing to branch/commit here — a spawn without isolation:worktree (or a cwd reset to the primary tree) would mis-branch the owner's checkout." >&2
	echo "  This run did NOT expect isolation (standalone) — take the Non-isolated fallback below to create a worktree before mutating." >&2
	exit 1
fi

# POSITIVE worktree assertion — loud + EARLY (#3458). git-dir != common-dir is the ONE trust signal
# for "I am in my own linked worktree" that survives the misleading env a worktree spawn is handed:
# $WORKTREE_ROOT is unset (the reverted #2938 provisioning hook) and $CLAUDE_CODE_AGENT reports the
# PARENT's value (inherited agent-type, #2462) — so neither can anchor worktree identity. This
# git-plumbing check can, and does so independently of both. Capture $WT from THIS evidence, never
# from the untrustworthy env and never from a file. This assertion fires BEFORE the first Edit/Write
# on purpose: a raw Edit/Write to a primary-checkout absolute path is not a git op, so neither the
# repo-side worktree-guard nor step4-wt-preflight.sh fires on it — the ONLY thing standing between a
# cwd-reset + stale-Read-cache and a stray write into shared primary `main` is anchoring every edit
# under this $WT (see "Anchor every Edit/Write to $WT").
WT="$(git rev-parse --show-toplevel)"
# STAMP THE LANE — this is the one moment $WT is trustworthy, so pin an identity to it (#4398).
# Every LATER Bash call re-derives the toplevel from a cwd the harness may have reset, so a
# cwd-derived "$WT" answers "where am I" and not "which tree is mine" — and a check that compares
# that answer against itself is tautological. $CLAUDE_CODE_SESSION_ID is the per-lane fact that
# DOES survive between calls (the same anchor §SP keys $RUN_SCRATCH on); write it into this
# worktree's PRIVATE per-worktree git dir, which is outside the working tree (never committed,
# never in `git status`) and unique per worktree. That stamp is the independently-derived operand
# step4-wt-preflight.sh compares the ambient cwd's answer against.
if [ -z "${CLAUDE_CODE_SESSION_ID:-}" ]; then
	echo "write-code preflight FAILED: no session id — no durable lane identity to stamp, so no later git mutation could be verified as mine." >&2
	exit 1
fi
printf '%s\n' "$CLAUDE_CODE_SESSION_ID" > "$GITDIR/kampus-lane" || {
	echo "write-code preflight FAILED: could not stamp the lane at $GITDIR/kampus-lane — no later git mutation could be verified as mine." >&2
	exit 1
}
# Open the stamp's LIFECYCLE at the same moment, not just its identity (#4868). The id is shared by
# every sibling lane of this session, so on its own it can never tell a live lane from a leftover
# tree; the beat is what a later reader measures, and `wt_preflight` refreshes it before every git
# mutation this lane makes. `step8-claim-release.sh` closes the lifecycle by retiring the stamp.
kp_lane_beat "$GITDIR"
echo "write-code preflight CONFIRMED (LOUD): in a LINKED worktree at $WT (git-dir != common-dir), stamped for lane $CLAUDE_CODE_SESSION_ID — worktree identity established from git plumbing, INDEPENDENT of \$WORKTREE_ROOT (${WORKTREE_ROOT:+set}${WORKTREE_ROOT:-unset}) and \$CLAUDE_CODE_AGENT (${CLAUDE_CODE_AGENT:-unset}), both of which may misreport. Anchor EVERY Edit/Write and git op to this \$WT (absolute) — never a primary-checkout path." >&2
printf 'GITDIR=%s\nCOMMON=%s\nWT=%s\n' "$GITDIR" "$COMMON" "$WT"
