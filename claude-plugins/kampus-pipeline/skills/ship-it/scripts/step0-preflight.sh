#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2016
# Step 0's preflight: the §RO-iso isolation assert, guard 6 Site 1, and the changed-file read.
#
# Extracted VERBATIM from ship-it/SKILL.md's Step 0 fenced block (epic #4435 phase 1, #4448).
# A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2 (#1929).
#
# SOURCED, never executed. The fenced block it replaces ran inline in the agent's shell, so this
# file deliberately sets NO shell options — several guards here depend on `pipefail` being OFF —
# and leaves its variables and functions in the sourcing shell, which is how the step's later
# blocks still see them.
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"
# §RO-iso's `iso_preflight`, sourced IN-CHAIN from its canonical home — the extraction dropped this
# line and left the call below command-not-found (#4547). Same idiom as review-code's
# `materialize-head.sh`; never a re-copy of the function.
# shellcheck source=../../shared/scripts/iso-preflight.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/scripts" && pwd)/iso-preflight.sh"

# The one seam this move needed: the block's `PR=<pr number>` placeholder was filled by whoever ran
# the step, so the sourcing site passes it instead — `. "$SHIPIT_SCRIPTS/step0-preflight.sh" <pr number>`.
# Fail closed on an absent one: an empty $PR addresses `repos/$REPO/pulls/` and reads as a clean miss.
PR="${1:-}"
if [ -z "$PR" ]; then
	printf 'ship-it Step 0: no PR number — source this as `. "$SHIPIT_SCRIPTS/step0-preflight.sh" <pr number>`.\n' >&2
	return 1
fi
# Isolation preflight FIRST. ship-it is §RO — it ships entirely over `gh api` / `gh pr merge`
# (server-side) and materializes NO head via local git — so it should never touch the primary
# checkout's git state. This is the defense-in-depth belt: if this ship-it spawn expected worktree
# isolation (shipper agent-type) but the #2440 harness no-op dropped it onto the shared PRIMARY
# checkout ($WORKTREE_ROOT unset — the #2452/#2453 condition), fail closed LOUD and route up rather
# than run any git op there. Single-sourced in gh-issue-intake-formats.md §RO-iso (ADR 0172; the
# write-code wt_preflight sibling). A genuine standalone `/ship-it` on the owner's checkout still proceeds.
# This iso_preflight is ship-it's whole stake in the #2690 worktree-hardening consolidation: LAYER 1
# (prevention) lives here, while LAYER 2 (the clean-tree assertion + the stage-all `git add -A` ban)
# has NO surface in ship-it — it stages/commits nothing — so it is enforced upstream in the pre-bash
# hook + write-code/review-code, not duplicated here.
iso_preflight ship-it || exit 1   # ../gh-issue-intake-formats.md §RO-iso — define it there, cite here

# Guard 6, SITE 1 (ADR 0198) — the first thing after $PR is known and BEFORE any gate branch, so a
# `--auto` armed by an earlier or INTERRUPTED run (#3700's mechanism — the run that reaches no exit
# path of its own, so no `refuse` site ever fires for it) cannot enqueue behind this run's back.
# $REPO was resolved at the top of the skill; $PR one line up. `disarm_intent` is defined in
# "The no-parked-merge-intent invariant" above. Abort on failure: a run that cannot establish the
# intent state cannot honor the invariant at any later site.
disarm_intent preflight || exit 1

gh api --paginate "repos/$REPO/pulls/$PR/files?per_page=100" --jq '.[].filename'   # --paginate + streaming --jq: full set past file #100 (the API caps per_page at 100; #725)
