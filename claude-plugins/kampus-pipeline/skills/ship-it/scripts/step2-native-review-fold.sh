#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2086
# Resolve the code namespace's in-force marker verdict and fold the newest decisive native review into it.
#
# Extracted VERBATIM from ship-it/SKILL.md's Step 2 fenced block (epic #4435 phase 1, #4448).
# A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2 (#1929).
#
# SOURCED, never executed. The fenced block it replaces ran inline in the agent's shell, so this
# file deliberately sets NO shell options — several guards here depend on `pipefail` being OFF —
# and leaves its variables and functions in the sourcing shell, which is how the step's later
# blocks still see them.
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

# the PR's CURRENT head SHA — the head every verdict must be bound to (ADR 0058)
CURRENT_HEAD="$(gh api repos/$REPO/pulls/$PR --jq .head.sha)"

# latest decisive native review (APPROVED / CHANGES_REQUESTED) — the review-code path only.
# GitHub author-attributes reviews, so this path is unforgeable and needs no ACL check. commit_id IS
# the SHA the reviewer approved, so the same staleness test applies to it as to a marker's @ <sha>.
# `at: .submitted_at` is load-bearing, not decoration: it is the timestamp the newest-wins fold below
# compares against the marker's write time. A review is never upserted, so `submitted_at` IS its write
# time — the two sides are like for like. Drop it and the fold degenerates to a precedence rule.
REVIEW=$(gh api "repos/$REPO/pulls/$PR/reviews?per_page=100" \
  --jq '[.[] | select(.state=="APPROVED" or .state=="CHANGES_REQUESTED")]
        | sort_by(.submitted_at) | last | {state, sha: .commit_id, at: .submitted_at}')

# resolve the verdict CLI via the `bin/pipeline-cli` shim — in-repo bin, else the installed bin,
# else the pinned `pnpm dlx` fallback reading the one pin (hooks/pin.sh); no version pinned here
# (#3653; ADR 0062/0064; epic #994)
VERDICT="${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/bin/pipeline-cli verdict"

# Resolve the CODE namespace only — it is the one namespace with work left to do here, because it is
# the only one a native GitHub review can decide, and `verdict gate` reads marker/advisory COMMENTS,
# not reviews. The per-namespace PASS/FAIL conjunction across doc / skill / design was already
# decided by the `verdict gate` call above, which runs FIRST and refuses on non-zero; re-resolving
# those three here set six variables nothing read, at six subprocess spawns per ship (#4405).
# CODE_PASS=1 iff a current-head PASS marker; CODE_FAIL=1 iff a current-head FAIL (the veto). A
# stale / SHA-less / none verdict exits non-zero on BOTH, so it is neither — Step 2b's `unverified
# (verdict not bound to current head)` refusal, owned by the verb. (A §CP advisory namespace is
# SHA-less by design and resolves `none` here; `verdict gate --cp` reads its body Reviewed-head.)
# The stdout JSON is kept because it carries `writtenAt`, the resolving verdict's WRITE time, which
# is what the newest-wins fold below compares (#4200).
CODE_JSON="$($VERDICT read --pr "$PR" --gate code --expect PASS 2>/dev/null)" && CODE_PASS=1 || CODE_PASS=0
$VERDICT read --pr "$PR" --gate code   --expect FAIL >/dev/null 2>&1 && CODE_FAIL=1   || CODE_FAIL=0

# fold the native decisive review into the code namespace (the verb reads only marker comments). Only
# a review bound to the current head counts (same ADR-0058 staleness as a marker's @ <sha>).
#
# The fold is NEWEST-WINS by timestamp, never FAIL-precedence — the resolution the prose below states.
# FAIL-precedence would be a live wedge, not a conservative default: a PR FAIL'd, repaired, and
# re-PASSed at the SAME head would stay permanently blocked by the superseded FAIL, breaking the
# repair → re-review → ship loop write-code drives.
RSTATE=$(jq -r '.state // ""' <<<"$REVIEW"); RSHA=$(jq -r '.sha // empty' <<<"$REVIEW")
RAT=$(jq -r '.at // ""' <<<"$REVIEW")
if [ -n "$RSHA" ]; then case "$CURRENT_HEAD" in "$RSHA"*)
  # the marker's WRITE time, straight off the verb's JSON — never the comment's created_at, which an
  # in-place upsert leaves behind (#4200). An empty MARKER_AT means no current-head marker verdict
  # stands (`verdict read` already dropped a none/sha-less/stale one) ⇒ the review decides alone.
  MARKER_AT=""
  [ "$((CODE_PASS + CODE_FAIL))" -gt 0 ] &&
    MARKER_AT=$(jq -r '.writtenAt // empty' <<<"$CODE_JSON" 2>/dev/null)
  # ISO-8601-UTC sorts lexically, so `>` IS the chronological compare.
  if [ -z "$MARKER_AT" ] || [ "$RAT" \> "$MARKER_AT" ]; then
    case "$RSTATE" in
      CHANGES_REQUESTED) CODE_FAIL=1; CODE_PASS=0 ;;
      APPROVED)          CODE_PASS=1; CODE_FAIL=0 ;;
    esac
  fi   # else the marker is newer and already stands — leave CODE_PASS/CODE_FAIL as the verb resolved them
;; esac; fi
