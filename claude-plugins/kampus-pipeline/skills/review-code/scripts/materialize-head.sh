#!/usr/bin/env bash
# Step 2 — §HEAD materialization: the isolation preflight, the fresh base fetch, the head worktree,
# and the ADR-0049/0052 instruction-denylist removal + absence assert. Extracted from
# review-code/SKILL.md (#4451, epic #4435 phase 1). Extraction contract + shell-option rationale:
# ../SKILL.md § The extracted scripts. The *why* for every step stays in that step's prose.
#
# usage: bash ./claude-plugins/kampus-pipeline/skills/review-code/scripts/materialize-head.sh <pr>
#
# STDOUT IS THE ANSWER (ADR 0232, .patterns/skill-script-io-contract.md) — four `KEY=value` lines:
#   REVIEW_WT / PR_REF / HEAD_SHA / BASE_REF
# Every progress, scope and FATAL line goes to stderr, so the four lines are the whole stdout. On ANY
# failure path stdout stays EMPTY and the exit is non-zero (§ZS: a materialization that could not run
# is UNKNOWN, and reviewing the BASE tree is the #793 false-PASS hazard).
#
# The same four values ALSO persist to a per-run §SP handle. That is not a second answer channel: the
# harness resets the agent's shell between Bash calls, so the LATER scripts of this skill re-source
# the handle in-process via `head-env.sh <pr>`, each passing the PR it was invoked for. In-script
# sourcing stays sanctioned under ADR 0232 — only the `.` at an agent's top-level command is banned.
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
PCLI="$(kp_pcli)" || exit 127

# Isolation preflight FIRST, before any head fetch / `git worktree add` below. If this
# review-code spawn expected worktree isolation (reviewer agent-type) but the #2440 harness no-op
# dropped it onto the shared PRIMARY checkout ($WORKTREE_ROOT unset), materializing the head here
# is the #2452/#2453 primary-checkout-detach surface — fail closed LOUD and route up, never
# materialize. Single-sourced in gh-issue-intake-formats.md §RO-iso (ADR 0172; the write-code
# wt_preflight sibling). A genuine standalone run on the owner's checkout still proceeds.
iso_preflight review-code >&2 || exit 1

# the trusted base — the PR's merge target at tip; your config already comes from here
BASE_REF="$(gh api repos/"$REPO"/pulls/"$PR" --jq '.base.ref')"   # normally main
[ -n "$BASE_REF" ] || { echo "FATAL: could not resolve the PR's base ref — aborting (the base is half of verification; §HEAD)." >&2; exit 1; }

# Refresh the base BEFORE any "is-it-shipped on main" ground-truth check (Step 3). The PR
# head reaches its own ref, but the base is the *other* half of verification — a long-lived
# or busy checkout's local main goes stale, so an "is X shipped?" check read off the working
# tree is only as fresh as whoever's checkout the gate ran in. This is the freshness gap
# complementary to ADR 0052's config-isolation: 0052 pins your *config* to the base; this
# pins your *ground-truth* to the base too. (PR #305 false-FAILed on exactly this — a doc
# whose consumers had merged minutes earlier was FAILed against a stale local main.)
git fetch origin "$BASE_REF" >&2

# §HEAD steps 1–3 (resolve the live head SHA, fetch pull/$PR/head into a per-run ref WITHOUT
# touching the session tree, assert the fetched ref IS that head, add a throwaway DETACHED head
# worktree) are the shared `pipeline-cli review-head materialize` verb (#3690 / #793 / #1807) —
# cite it, don't re-derive it. `pull/<pr>/head` resolves for same-repo AND cross-fork PRs, so there
# is no separate cross-fork branch to check out (the trust inversion ADR 0052 closes); the verb
# never runs `gh pr checkout` / `git checkout` / `git switch` (which would land the head in the
# shared PRIMARY the harness resets this cwd to and detach the human's `main` — #2270/#1103), and it
# nonce-uniques the ref per invocation so a concurrent review of the same PR can't overwrite it
# (#1807). It emits the resolved head + ref + worktree as JSON. Persist those to a per-run handle so
# they survive the harness cwd/shell reset between Bash calls (a shell var is lost across calls) —
# NEVER re-derive from a shared leaf name (a `git worktree list` re-derivation matches a SIBLING
# reviewer's tree and pins the wrong head).
# The `--worktree` tree is a FULL checkout (ADR 0067): biome.jsonc + biome-plugins/, patches/, the
# catalog/lockfile, and everything `fate generate` needs are present, so the typecheck bootstrap is
# whole. A full checkout also lands the head's root CLAUDE.md + .claude/.decisions/.patterns — that
# leak is closed by the explicit denylist removal + absence-assert below, NOT by any pattern set.
# The slug is keyed by PR, not by session alone: a fanned drain runs several `review-code` gates in
# ONE session, so a constant slug made them share one handle and the last writer won (#5416). The
# `HANDLE_PR` stamp is the same fact recorded INSIDE the file, which is what lets every reader
# refuse a handle that reached it by any route the slug does not cover — see
# `kp_head_handle_names_pr`.
WT_FILE="$(kp_scratch_open "review-code-head-$PR")/head.env" || exit 1
"$PCLI" review-head materialize --pr "$PR" --worktree \
  | jq -r '"REVIEW_WT=\(.worktreeDir)\nPR_REF=\(.prRef)\nHEAD_SHA=\(.headSha)"' > "$WT_FILE"
printf 'BASE_REF=%s\nHANDLE_PR=%s\n' "$BASE_REF" "$PR" >> "$WT_FILE"
# shellcheck disable=SC1090  # the run-unique handle this script just wrote
. "$WT_FILE"
[ -n "${REVIEW_WT:-}" ] && [ -n "${PR_REF:-}" ] && [ -n "${HEAD_SHA:-}" ] || {
  echo "FATAL: review-head materialize did not yield a head worktree — aborting (never review the base tree; §HEAD)." >&2; exit 1; }

# LAYER-2 containment (#2666): a freshly materialized worktree MUST come up pristine — assert it
# clean NOW, before the denylist `rm --cached` below deliberately dirties it. A dirty materialization
# means a corrupted head checkout, and reviewing a contaminated tree is a false signal. Fail-closed
# LOUD via the single-sourced, tested helper (packages/pipeline-cli/src/tools/worktree-guard).
"$PCLI" worktree-guard assert-clean --path "$REVIEW_WT" >&2 || {
  echo "FATAL: review worktree came up dirty at materialization — aborting (never review a contaminated tree; #2666)." >&2
  exit 1
}

# Enforce the instruction denylist EXPLICITLY: remove the head's instruction surfaces from
# the review tree so they never reach the reviewing agent's path (ADR 0049/0052 boundary; a
# full checkout would otherwise leave root CLAUDE.md on disk). Config still comes from the
# trusted base — this tree is run *against* via `pnpm -C`, never `cd`'d into.
git -C "$REVIEW_WT" rm -r -q --cached --ignore-unmatch \
  CLAUDE.md .claude .decisions .patterns >&2
rm -rf "$REVIEW_WT/CLAUDE.md" "$REVIEW_WT/.claude" "$REVIEW_WT/.decisions" "$REVIEW_WT/.patterns"

# ASSERT absence — the load-bearing isolation check (ADR 0067 §Consequences). If any denied
# path is still on disk the isolation is broken: abort the review rather than read head config.
for p in CLAUDE.md .claude .decisions .patterns; do
  if [ -e "$REVIEW_WT/$p" ]; then
    echo "FATAL: denied instruction surface '$p' present in review worktree — isolation broken; aborting" >&2
    exit 1
  fi
done

# THE ANSWER — the four resolved values, one KEY=value line each, and the only stdout this script
# writes. Printed from the variables the handle read back above, so what the caller sees and what the
# later steps re-source through head-env.sh are the same four values by construction.
printf 'REVIEW_WT=%s\nPR_REF=%s\nHEAD_SHA=%s\nBASE_REF=%s\n' "$REVIEW_WT" "$PR_REF" "$HEAD_SHA" "$BASE_REF"
