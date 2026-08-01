#!/usr/bin/env bash
# Step 4's branch cut: fetch the base fresh, derive the prefix from this checkout's git identity, and
# create the per-run branch off FETCH_HEAD under the per-mutation worktree preflight.
#
# usage: step4-branch.sh <slug-for-issue-N>
#
# stdout is the one line `BRANCH=<name>` — a machine value, so diagnostics go to stderr. Non-zero
# means NO branch was created. Read the name only to SEE it: every later git op RE-DERIVES the branch
# live from the worktree HEAD and never carries this value (the #2038 cross-lane clobber).
#
# Executed, never sourced (ADR 0232). `wt_preflight` used to be a function in the sourcing shell; it
# is now `step4-wt-preflight.sh`, executed as a child, and its printed worktree root is what the git ops
# below are addressed at with `-C` (a child process cannot `cd` its caller).
# shellcheck disable=SC1007,SC1091,SC2016
set -uo pipefail
# shellcheck source=../../../lib/common.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

HERE="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
[ -n "$HERE" ] || { echo "write-code Step 4: could not resolve this script's own directory — NO branch was created." >&2; exit 1; }

# Fail closed on an absent slug — an empty one yields `$PREFIX/-<nonce>`, a branch name that is legal,
# meaningless, and names no issue.
SLUG="${1:-}"
if [ -z "$SLUG" ]; then
	printf 'write-code Step 4: no branch slug — run this as `bash ./claude-plugins/kampus-pipeline/skills/write-code/scripts/step4-branch.sh <slug-for-issue-N>`. NO branch was created.\n' >&2
	exit 1
fi
# The branch create is a git mutation, so it is gated on the per-mutation preflight — resolved FIRST,
# because every git op below must be addressed at MY lane's tree and not at whatever the cwd names.
WT="$(bash "$HERE/step4-wt-preflight.sh")" || { echo "write-code Step 4: the worktree preflight refused — NO branch was created." >&2; exit 1; }
# Fetch the base fresh, and FAIL-LOUD if it doesn't run: FETCH_HEAD is what the branch below is
# cut from, so a silently-failed fetch (network blip, a harness worktree whose exec env stripped
# PATH) leaves FETCH_HEAD at a STALE prior tip, and the branch misses a base file merged just
# before branch-cut → the SHA-bound run-evidence check false-fails on a file the head never
# carried (#1920; the same stale-base class #1837 fixed at the repair step). Never proceed on an
# unverified fetch — assert it succeeded before branching off FETCH_HEAD.
git -C "$WT" fetch origin main || { echo "write-code: 'git fetch origin main' failed — refusing to branch off a stale FETCH_HEAD (would cut a head missing a just-merged base file; #1920)." >&2; exit 1; }
# Derive the prefix from THIS checkout's git identity — never a hardcoded literal. A copied
# literal namespaces every agent's branch under one person's handle regardless of who runs.
PREFIX="$(git -C "$WT" config user.name | tr '[:upper:] ' '[:lower:]-')"   # e.g. "Umut Sirin" → "umut-sirin"
if [ -z "$PREFIX" ]; then
	# empty identity ⇒ "/slug…" (leading slash) git rejects with an opaque error; fail here with a fixable one
	echo "write-code Step 4: set git user.name to derive a branch prefix — NO branch was created." >&2
	exit 1
fi
# Per-run suffix: the deterministic $PREFIX/<slug-for-issue-N> is the SAME ref for every
# run on this issue, so two concurrent runs would both push origin/<that branch> and the
# second push would clobber the first's commits. A per-invocation nonce keeps them distinct.
BRANCH="$PREFIX/$SLUG-$(uuidgen | head -c 8)"
git -C "$WT" switch -c "$BRANCH" FETCH_HEAD || { echo "write-code Step 4: 'git switch -c' failed — NO branch was created." >&2; exit 1; }
printf 'BRANCH=%s\n' "$BRANCH"
