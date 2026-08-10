#!/usr/bin/env bash
# Proof for #4591: `iso_preflight` ANSWERS under a `set -u` sourcing caller, on all three states of
# each isolation signal, and still refuses everything it refused before.
#
# usage: bash ./claude-plugins/kampus-pipeline/skills/shared/scripts/iso-preflight-setu-proof.sh
#        exit 0 ⇒ every case matched; exit 1 ⇒ at least one FAIL line above.
#
# It re-derives the claim instead of asserting it, the way `write-code/scripts/verify-fail-closed.sh`
# does: a throwaway sandbox repo supplies a real PRIMARY checkout and a real LINKED worktree, and each
# case runs the guard as `review-code/scripts/materialize-head.sh` runs it — sourced into a
# `set -uo pipefail` shell — across `CLAUDE_CODE_AGENT` × `WORKTREE_ROOT` ∈ {unset, blank, value}.
#
# The two properties under test, and why each needs its own case:
#   1. NO case may abort. An unbound-variable abort produced a reasonless non-zero with empty output,
#      which is indistinguishable from a guard that ran and refused — so every case asserts that the
#      scope line was printed, not merely that the status was expected.
#   2. Defaulting must not fail the guard OPEN. The refusal cases pin that the LOUD ROUTED BLOCKER
#      still fires on the primary checkout whenever isolation was expected, and the one green case is
#      green on git plumbing (`git-dir != common-dir`), never on an env read.
#
# No EXIT trap (`.patterns/skill-script-shell-shape.md`; #4476, class #4479) — the sandbox is removed
# on the single exit path at the bottom, which every case reaches because nothing here uses `-e`.
# shellcheck disable=SC1007  # the house `CDPATH= cd --` idiom on the GUARD resolution below
set -uo pipefail

FAILS=0
GUARD="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/iso-preflight.sh"
[ -f "$GUARD" ] || { echo "FAIL: guard not found at $GUARD — refusing to prove nothing (ADR 0092)"; exit 1; }

SANDBOX="$(mktemp -d)"
if [ -z "$SANDBOX" ] || [ ! -d "$SANDBOX" ]; then
	echo "FAIL: mktemp -d produced no sandbox — refusing to run against nothing (ADR 0092)"
	exit 1
fi

# Physically-resolved, because the second half of this proof is precisely about logical-vs-physical
# path resolution: on darwin `mktemp -d` hands back a /var path that is a symlink to /private/var, so
# an unresolved sandbox would exercise only the symlinked case and never the plain one.
SANDBOX="$(cd "$SANDBOX" && pwd -P)"
PRIMARY="$SANDBOX/primary"
LINKED="$SANDBOX/linked"
git init -q "$PRIMARY" >/dev/null 2>&1
git -C "$PRIMARY" -c user.email=proof@example.invalid -c user.name=iso-preflight-proof \
	commit -q --allow-empty -m "sandbox base" >/dev/null 2>&1
git -C "$PRIMARY" worktree add -q "$LINKED" -b proof-lane >/dev/null 2>&1
ln -s "$PRIMARY" "$SANDBOX/via-link"
if [ ! -d "$LINKED" ] || [ ! -L "$SANDBOX/via-link" ]; then
	echo "FAIL: could not stand up a linked worktree + a symlinked path in the sandbox — the matrix would be half-blind"
	rm -rf "$SANDBOX"
	exit 1
fi

# run_case <label> <tree> <mode:sourced|executed> <env-state:unset|blank|reviewer> <want-status> <needle>
# The needle is matched over stdout+stderr together: which stream a line lands on is the io-contract's
# business (pinned elsewhere), while what this proof pins is that the guard SPOKE at all.
run_case() {
	local label="$1" tree="$2" mode="$3" state="$4" want="$5" needle="$6"
	local envargs out err got
	case "$state" in
		unset) envargs=(-u CLAUDE_CODE_AGENT -u WORKTREE_ROOT) ;;
		blank) envargs=(CLAUDE_CODE_AGENT= WORKTREE_ROOT=) ;;
		# `-u` first: env stops reading options at the first NAME=VALUE, so a trailing `-u X` would be
		# taken as the command to run.
		reviewer) envargs=(-u WORKTREE_ROOT CLAUDE_CODE_AGENT=crew-reviewer) ;;
		*) echo "FAIL [$label]: unknown env state '$state'"; FAILS=$((FAILS + 1)); return 0 ;;
	esac
	if [ "${#envargs[@]}" -eq 0 ]; then
		echo "FAIL [$label]: empty env argument list — a bash 3.2 empty-array expansion would pass \`\` as a name"
		FAILS=$((FAILS + 1))
		return 0
	fi
	out="$SANDBOX/out.$$"
	err="$SANDBOX/err.$$"
	if [ "$mode" = sourced ]; then
		# EXACTLY the materialize-head.sh shape: the caller owns `set -uo pipefail`, the guard is
		# sourced into it, and the call is `iso_preflight <surface>`.
		(cd "$tree" && env "${envargs[@]-}" bash -u -o pipefail \
			-c '. "$1"; iso_preflight proof-surface' _ "$GUARD") >"$out" 2>"$err"
	else
		(cd "$tree" && env "${envargs[@]-}" bash "$GUARD" proof-surface) >"$out" 2>"$err"
	fi
	got=$?
	if [ "$got" != "$want" ]; then
		echo "FAIL [$label]: exit $got, wanted $want"
		FAILS=$((FAILS + 1))
	fi
	# Property 1 — the guard SPOKE. An abort printed only bash's own `unbound variable` line, so an
	# answer is proven by the scope line being present and that line being absent.
	if ! grep -q 'proof-surface iso_preflight:' "$out" "$err"; then
		echo "FAIL [$label]: no scope line — the guard did not reach its answer"
		FAILS=$((FAILS + 1))
	fi
	if grep -q 'unbound variable' "$err"; then
		echo "FAIL [$label]: aborted on an unbound variable — the #4591 defect is back"
		FAILS=$((FAILS + 1))
	fi
	if ! grep -q "$needle" "$out" "$err"; then
		echo "FAIL [$label]: expected text not found: $needle"
		FAILS=$((FAILS + 1))
	fi
	rm -f "$out" "$err"
}

for MODE in sourced executed; do
	# The green that was unreachable before: a real linked worktree with WORKTREE_ROOT unset. It is
	# green on `git-dir != common-dir` alone, which is why the same case is green in all three env
	# states below rather than only when the env cooperates.
	run_case "$MODE/linked/unset" "$LINKED" "$MODE" unset 0 'CONFIRMED: LINKED worktree'
	run_case "$MODE/linked/blank" "$LINKED" "$MODE" blank 0 'CONFIRMED: LINKED worktree'
	run_case "$MODE/linked/reviewer" "$LINKED" "$MODE" reviewer 0 'CONFIRMED: LINKED worktree'

	# The refusal is intact: isolation expected (reviewer agent-type) on the PRIMARY checkout still
	# fails closed LOUD — and now prints its reason, which was the whole complaint.
	run_case "$MODE/primary/reviewer" "$PRIMARY" "$MODE" reviewer 1 'ROUTED BLOCKER'

	# ADR 0172's standalone branch, unchanged in policy and now reachable. Both env states proceed,
	# and both name the absence they concluded from rather than claiming a check they did not make.
	run_case "$MODE/primary/unset" "$PRIMARY" "$MODE" unset 0 'no isolation-expected evidence'
	run_case "$MODE/primary/blank" "$PRIMARY" "$MODE" blank 0 'no isolation-expected evidence'

	# The SAME primary checkout reached through a symlink. Both refusals below fired only after the
	# two path sides were resolved the same way — before that, the symlinked primary compared unequal
	# and the guard passed it as a linked worktree, which is a fail-OPEN in the exact state the guard
	# exists to catch.
	run_case "$MODE/symlinked-primary/reviewer" "$SANDBOX/via-link" "$MODE" reviewer 1 'ROUTED BLOCKER'
	run_case "$MODE/symlinked-primary/unset" "$SANDBOX/via-link" "$MODE" unset 0 'no isolation-expected evidence'
done

# "I could not check" is distinguishable from "I checked": unset and exported-blank must not render
# the same. The old scope line printed `${WORKTREE_ROOT:+set}` for both, which is how the first state
# lost its voice.
UNSET_LINE="$( (cd "$PRIMARY" && env -u CLAUDE_CODE_AGENT -u WORKTREE_ROOT bash "$GUARD" proof-surface) 2>/dev/null | head -1)"
BLANK_LINE="$( (cd "$PRIMARY" && env CLAUDE_CODE_AGENT= WORKTREE_ROOT= bash "$GUARD" proof-surface) 2>/dev/null | head -1)"
case "$UNSET_LINE" in
	*'worktree-root=UNSET(never-exported)'*) ;;
	*) echo "FAIL [observability]: an unset WORKTREE_ROOT did not report itself as UNSET"; FAILS=$((FAILS + 1)) ;;
esac
case "$BLANK_LINE" in
	*'worktree-root=empty(exported-blank)'*) ;;
	*) echo "FAIL [observability]: an exported-blank WORKTREE_ROOT did not report itself as blank"; FAILS=$((FAILS + 1)) ;;
esac

git -C "$PRIMARY" worktree remove --force "$LINKED" >/dev/null 2>&1
rm -rf "$SANDBOX"

if [ "$FAILS" -ne 0 ]; then
	echo "iso-preflight-setu-proof: $FAILS assertion(s) FAILED"
	exit 1
fi
echo "iso-preflight-setu-proof: OK — 16 sourced/executed cases + 2 observability assertions passed"
