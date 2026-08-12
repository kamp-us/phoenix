#!/usr/bin/env bash
# Re-derives, rather than asserts, that `review-code`'s head handle is PR-keyed and that every
# consumer of it fails closed on a handle describing another PR (#5416).
#
# The defect this pins is silent by construction, which is why it needs a proof rather than a
# reading. The handle used to be keyed by session alone, so two `review-code` gates fanned in ONE
# session — the normal drain shape — shared a single `head.env` and the last materialization won.
# The reviewer then verified a SIBLING PR's tree while reading its own PR's live head SHA straight
# from the API, so the marker it posted was correctly bound to a tree it never checked. Marker-shape
# validation, the post-time SHA cross-check and ADR 0058 staleness all pass that: a wrong-tree green
# is indistinguishable from a right-tree green.
#
# Nine cases, driven under ONE session id because same-session collision is the whole failure:
#   1  two PRs, one session          -> two DIFFERENT namespaces (the keying itself)
#   2  handle that matches           -> exit 0, its path on stdout
#   3  handle stamped for ANOTHER PR -> non-zero, EMPTY stdout (the clobber, now refused)
#   4  unstamped legacy handle       -> non-zero (a PR that cannot be established is UNKNOWN)
#   5  stamp right, worktree wrong   -> non-zero (the stamp alone is not the whole evidence)
#   6  no <pr> argument              -> exit 2 (a caller that cannot name its PR gets no handle)
#   7  every consumer, mismatched    -> non-zero, and the sibling's tree is still there
#   8  teardown, mismatched          -> non-zero, sibling tree NOT removed (#5416's teardown half)
#   9  falsifiability                -> a mutant with the constant slug collides the two PRs again
#
# Hermetic: no network, no `gh`, and it never reaches a `pnpm` run — every consumer case is a
# refusal, which happens before any command runs. It touches no worktree and no ref of the checkout
# it runs in.
#
# usage: bash claude-plugins/kampus-pipeline/skills/review-code/scripts/verify-head-handle-pr-keyed.sh
#
# Shell shape per .patterns/skill-script-shell-shape.md: `set -uo pipefail`, never `-e`, no `EXIT`
# trap — under bash 3.2 a cleanup trap's last command becomes the exit status and would launder a
# `set -u` abort into the exit 0 this harness's whole contract rests on.
# SC2016 is declared, not waved off: the mutant's sed program matches the LITERAL `$PR` in the
# script's source text, so expanding it here would rewrite the mutant into something that reverts
# nothing.
# shellcheck disable=SC1007,SC1091,SC2016
set -uo pipefail
HERE="$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd -P)"
PLUGIN="$(CDPATH= cd -P -- "$HERE/../../.." && pwd -P)"
# shellcheck source=../../../lib/common.sh
. "$PLUGIN/lib/common.sh"
PCLI="$(kp_pcli)" || exit 127

FAILED=0
ok() { printf 'PASS  %s\n' "$1"; }
bad() {
	printf 'FAIL  %s\n' "$1"
	FAILED=1
}

TMP="$(mktemp -d)"
if [ -z "$TMP" ] || [ ! -d "$TMP" ]; then
	echo "FAIL: mktemp -d produced no temp root — refusing to run against nothing (ADR 0092)"
	exit 1
fi

SESSION="head-pr-proof-$$"
MINE=811001
SIBLING=811002
MINE_WT="$TMP/review-head-$MINE-proof"
SIBLING_WT="$TMP/review-head-$SIBLING-proof"
mkdir -p "$MINE_WT" "$SIBLING_WT"

open_ns() { CLAUDE_CODE_SESSION_ID="$SESSION" "$PCLI" scratchpad open --slug "$1" 2>/dev/null; }
run_head_env() { CLAUDE_CODE_SESSION_ID="$SESSION" bash "$HERE/head-env.sh" "$@" 2>/dev/null; }

DIR_MINE="$(open_ns "review-code-head-$MINE")"
DIR_SIBLING="$(open_ns "review-code-head-$SIBLING")"
if [ -z "$DIR_MINE" ] || [ -z "$DIR_SIBLING" ]; then
	echo "FAIL: zero scope — the scratch namespaces could not be opened, so nothing below was tested (ADR 0092)"
	exit 1
fi

# A well-formed handle, exactly as `materialize-head.sh` writes one.
handle() { # <dir> <stamped-pr> <worktree> <ref-pr>
	printf 'REVIEW_WT=%s\nPR_REF=refs/pr/%s-proof\nHEAD_SHA=%s\nBASE_REF=main\nHANDLE_PR=%s\n' \
		"$3" "$4" "0000000000000000000000000000000000000000" "$2" >"$1/head.env"
}

# 1 — the keying itself. One session, two PRs, two namespaces. Pre-fix these were the same path.
if [ "$DIR_MINE" != "$DIR_SIBLING" ]; then
	ok "1 two PRs in one session -> two namespaces"
else
	bad "1 both PRs resolved to $DIR_MINE — the handle is not PR-keyed"
fi

# 2 — the handle that matches is handed over.
handle "$DIR_MINE" "$MINE" "$MINE_WT" "$MINE"
OUT="$(run_head_env "$MINE")"
RC=$?
if [ "$RC" -eq 0 ] && [ "$OUT" = "$DIR_MINE/head.env" ]; then
	ok "2 matching handle -> exit 0, path on stdout"
else
	bad "2 expected $DIR_MINE/head.env at exit 0, got rc=$RC out=${OUT:-<empty>}"
fi

# 3 — THE defect: the namespace holds a handle describing the sibling. Pre-fix this is what every
# consumer read, and it read as perfectly well-formed.
handle "$DIR_SIBLING" "$MINE" "$MINE_WT" "$MINE"
OUT="$(run_head_env "$SIBLING")"
RC=$?
if [ "$RC" -ne 0 ] && [ -z "$OUT" ]; then
	ok "3 handle for another PR -> non-zero, empty stdout"
else
	bad "3 a sibling's handle was handed over (rc=$RC out=${OUT:-<empty>})"
fi

# 7 — every consumer refuses the same mismatch, and none of them touches the tree it names. Run
# while $DIR_SIBLING still holds case 3's mismatched handle.
for consumer in worktree-typecheck worktree-checks full-unit-project teardown-head glossary-freshness; do
	CLAUDE_CODE_SESSION_ID="$SESSION" CLAUDE_PIPELINE_REPO=owner/repo \
		bash "$HERE/$consumer.sh" "$SIBLING" >/dev/null 2>&1
	RC=$?
	if [ "$RC" -ne 0 ] && [ -d "$MINE_WT" ]; then
		ok "7 $consumer refuses a sibling's handle (rc=$RC), sibling tree intact"
	else
		bad "7 $consumer acted on a sibling's handle (rc=$RC, tree-present=$([ -d "$MINE_WT" ] && echo yes || echo no))"
	fi
done

# 8 — teardown is called out separately because its failure mode is destruction, not mis-reading:
# a reviewer finishing one PR used to `rm -rf` another's live tree. Case 7 ran it above; this
# asserts the surviving tree is the point, not a side effect.
if [ -d "$MINE_WT" ]; then
	ok "8 teardown removed nothing that was not its own"
else
	bad "8 teardown deleted the sibling's live worktree"
fi

# 4 — a legacy handle with no stamp. Its PR cannot be established, and unestablished is UNKNOWN.
printf 'REVIEW_WT=%s\nPR_REF=refs/pr/%s-proof\nBASE_REF=main\n' "$SIBLING_WT" "$SIBLING" >"$DIR_SIBLING/head.env"
OUT="$(run_head_env "$SIBLING")"
RC=$?
if [ "$RC" -ne 0 ] && [ -z "$OUT" ]; then
	ok "4 unstamped handle -> non-zero, empty stdout"
else
	bad "4 an unstamped handle was handed over (rc=$RC out=${OUT:-<empty>})"
fi

# 5 — the stamp says the right PR while the worktree it names is another's. The stamp and the names
# are separate evidence, so a handle that half-corresponds is still a refusal.
handle "$DIR_SIBLING" "$SIBLING" "$MINE_WT" "$SIBLING"
OUT="$(run_head_env "$SIBLING")"
RC=$?
if [ "$RC" -ne 0 ] && [ -z "$OUT" ]; then
	ok "5 right stamp, wrong worktree -> non-zero"
else
	bad "5 a handle naming another PR's tree was handed over (rc=$RC out=${OUT:-<empty>})"
fi

# 6 — a caller that does not name its PR cannot be told which handle is its own.
OUT="$(run_head_env)"
RC=$?
if [ "$RC" -eq 2 ] && [ -z "$OUT" ]; then
	ok "6 no <pr> argument -> exit 2, empty stdout"
else
	bad "6 expected exit 2 with empty stdout, got rc=$RC out=${OUT:-<empty>}"
fi

# 9 — falsifiability. A mutant that reverts the slug to the constant `review-code-head` and drops
# the correspondence guard must collide the two PRs again. It lives at the same depth as the
# original: the script resolves its shared lib through `../../../lib`, so a mutant in a flat temp
# dir would die at lib resolution — an exit this harness could score as "caught" while testing
# nothing.
MUT_DIR="$TMP/tree/skills/review-code/scripts"
mkdir -p "$MUT_DIR"
ln -s "$PLUGIN/lib" "$TMP/tree/lib"
MUTANT="$MUT_DIR/mutant-head-env.sh"
sed -e 's/"review-code-head-\$PR"/review-code-head/' -e '/kp_head_handle_names_pr/d' \
	"$HERE/head-env.sh" >"$MUTANT"
if cmp -s "$HERE/head-env.sh" "$MUTANT"; then
	bad "9 the mutant is byte-identical to the original — it reverts nothing"
else
	# The un-keyed namespace is the one the pre-fix code wrote into, so the fixture opens it and
	# gives it the sibling's handle — the state the last materialization of a fanned drain left.
	DIR_CONSTANT="$(open_ns review-code-head)"
	handle "$DIR_CONSTANT" "$SIBLING" "$SIBLING_WT" "$SIBLING"
	M_MINE="$(CLAUDE_CODE_SESSION_ID="$SESSION" bash "$MUTANT" "$MINE" 2>/dev/null)"
	M_SIBLING="$(CLAUDE_CODE_SESSION_ID="$SESSION" bash "$MUTANT" "$SIBLING" 2>/dev/null)"
	if [ -n "$M_MINE" ] && [ "$M_MINE" = "$M_SIBLING" ]; then
		ok "9 constant slug + no guard -> both PRs read one handle (the filed defect)"
	else
		bad "9 the mutant did not reproduce the collision (mine=${M_MINE:-<empty>} sibling=${M_SIBLING:-<empty>})"
	fi
fi

rm -rf "$TMP" "$DIR_MINE" "$DIR_SIBLING" "${DIR_CONSTANT:-}"
if [ "$FAILED" -ne 0 ]; then
	echo "head-handle PR-keying proof: FAILED" >&2
	exit 1
fi
echo "head-handle PR-keying proof: the handle is PR-keyed and every consumer fails closed on another PR's handle"
