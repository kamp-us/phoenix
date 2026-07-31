#!/usr/bin/env bash
# Step 1 — §RO-iso preflight, then land the PR head in a per-run ref (no checkout) and resolve the
# linked issue. Extracted from review-trivial/SKILL.md (#4453, epic #4435 phase 1). Extraction
# contract + shell-option rationale: ../SKILL.md § The extracted scripts.
#
# STDOUT IS A MACHINE CHANNEL: the only stdout lines are the `HEAD_SHA=` / `PR_REF=` / `ISSUE=`
# answer, so the caller can `eval` or read them. The issue body the fence printed goes to stderr —
# the caller reads it from the run log, or re-reads it off the printed `ISSUE=`. On ANY failure path
# stdout stays EMPTY and the exit is non-zero: a materialization that could not run is UNKNOWN, and
# reviewing the launched checkout's base tree is the #793 false-PASS hazard.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"
# §RO-iso's `iso_preflight`, sourced from its canonical home rather than re-copied (#4489 extracted
# it out of ../../gh-issue-intake-formats.md).
# shellcheck source=../../shared/scripts/iso-preflight.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/scripts" && pwd)/iso-preflight.sh"

[ "$#" -ge 1 ] || { echo "usage: materialize-head.sh <pr>" >&2; exit 2; }
PR="$1"
REPO="$(kp_repo)" || exit 1

# Isolation preflight FIRST, before the head fetch below. If this review-trivial spawn expected
# worktree isolation (reviewer agent-type) but the #2440 harness no-op dropped it onto the shared
# PRIMARY checkout ($WORKTREE_ROOT unset), fetching the head here is the #2452/#2453
# primary-checkout-detach surface — fail closed LOUD and route up. Single-sourced in
# gh-issue-intake-formats.md §RO-iso (ADR 0172; the write-code wt_preflight sibling). A genuine
# standalone run on the owner's checkout still proceeds (the head read is via `git show`, checkout-free).
iso_preflight review-trivial >&2 || exit 1   # ../gh-issue-intake-formats.md §RO-iso — define it there, cite here

HEAD_SHA="$(gh pr view "$PR" --repo "$REPO" --json headRefOid -q .headRefOid)"
# Shape-assert before the SHA can reach a `git fetch` argument or the caller's `@ <sha>` field: gh
# writes its error document to STDOUT on failure, so an unchecked capture is non-empty garbage.
case "$HEAD_SHA" in
  *[!0-9a-f]*|"") echo "materialize-head.sh: head SHA is not bare hex — discarded; NO head was materialized (§HEAD)." >&2; exit 1 ;;
esac
[ "${#HEAD_SHA}" -eq 40 ] || { echo "materialize-head.sh: head SHA is not a 40-char ref — discarded." >&2; exit 1; }
PR_REF="refs/review-trivial/$PR"
git fetch --no-tags origin "pull/$PR/head:$PR_REF" >/dev/null 2>&1 || git fetch origin "$HEAD_SHA" >/dev/null 2>&1
# read a head file WITHOUT a checkout:  git show "$PR_REF:<path>"   (or "$HEAD_SHA:<path>")
# NEVER `git checkout` / `git switch` to inspect the head — the harness resets this cwd to the
# shared PRIMARY between Bash calls, so a checkout lands there and detaches the human's `main`
# (#2270/#1103); §RO in gh-issue-intake-formats.md forbids switching any working tree outright.
git rev-parse --verify --quiet "$PR_REF^{commit}" >/dev/null || {
  echo "materialize-head.sh: neither fetch landed $PR_REF — the head is NOT readable, so nothing may be reviewed (§HEAD)." >&2; exit 1; }

# the PR body carries Fixes #N; pin the linked issue and its acceptance criteria
ISSUE=$(gh api repos/"$REPO"/pulls/"$PR" --jq '.body' | grep -ioE '(fix(es|ed)?|close[sd]?|resolve[sd]?)\s+#[0-9]+' | grep -oE '[0-9]+' | head -n1)
gh api repos/"$REPO"/issues/"$ISSUE" --jq '.body' >&2   # the ### Acceptance criteria you verify against

printf 'HEAD_SHA=%s\nPR_REF=%s\nISSUE=%s\n' "$HEAD_SHA" "$PR_REF" "${ISSUE:-}"
