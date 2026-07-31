#!/usr/bin/env bash
# Step 0's concurrent-sweep claim on #N: detect-and-tiebreak by self-assigning, NOT a lock
# (../../gh-issue-intake-formats.md §7 owns the semantics).
#
# usage: claim-issue.sh <N>
#
# EXIT-CODE CONTRACT — the loop-control seam. The moved block used `continue` to step to the
# next issue, which a separate process cannot do, so each `continue` became an exit code the
# caller reads (`claim-issue.sh "$N" || continue`):
#   0  claim WON and CONFIRMED — triage #N, then release in Step 6. Prints `claim: won #N`.
#   3  backed off: #N was already claimed, or this sweep lost the tiebreak. Nothing left behind.
#   1  could not run (repo unresolved, bad usage is 2) — UNKNOWN, so NOT a win.
# Exit 0 is reachable only through the checkpoint GET below returning this login as min, so an
# unread response can never surface as a win: a failed POST leaves `$ASSIGNEES` empty and a failed
# checkpoint leaves `$STILL` empty, and both compute a winner that is not `$ME` ⇒ exit 3. stdout
# carries the `claim: won` line on that one path and nothing on any other, so neither the exit
# status nor an empty stdout can be read as the permissive answer.
#
# Extracted from triage/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: claim-issue.sh <N>" >&2; exit 2; }
N="$1"
REPO="$(kp_repo)" || exit 1

ME=$(gh api user --jq '.login')

# Rule 0 — defer to a pre-existing owner. If #N is already claimed (by a sibling sweep,
# or — see the release note below — by a write-code agent that picked an already-triaged
# issue), back off WITHOUT POSTing and move to the next issue. A fresh arrival never
# evicts an owner that was there before it.
PRE=$(gh api "repos/$REPO/issues/$N" --jq '[.assignees[].login] | sort | join(" ")')
[ -n "$PRE" ] && { echo "claim: #$N already claimed by '$PRE' — backing off." >&2; exit 3; }

# POST self; capture the FULL assignees list the write returns (one observable write).
ASSIGNEES=$(gh api -X POST "repos/$REPO/issues/$N/assignees" \
  -f "assignees[]=$ME" --jq '[.assignees[].login] | sort | join(" ")')

# Provisional tiebreak among co-racers: min-login. The POST echo only DETECTS a race
# (staggered co-racers see different sets and both may compute themselves min); the
# checkpoint GET below RESOLVES it. See §7 for the full derivation.
# shellcheck disable=SC2086  # word splitting is the point: $ASSIGNEES is a space-joined list
WINNER=$(printf '%s\n' $ASSIGNEES | head -n1)
if [ "$WINNER" = "$ME" ]; then
  # shellcheck disable=SC2086
  for a in $ASSIGNEES; do
    [ "$a" = "$ME" ] && continue
    gh api -X DELETE "repos/$REPO/issues/$N/assignees" -f "assignees[]=$a"
  done
  # CHECKPOINT — re-read canonical state (a fresh GET, not the stale POST echo) and
  # re-confirm I am still min(assignees). This is what resolves the race; do not prune it.
  STILL=$(gh api "repos/$REPO/issues/$N" --jq '[.assignees[].login] | sort | join(" ")')
  # shellcheck disable=SC2086
  [ "$(printf '%s\n' $STILL | head -n1)" = "$ME" ] || {
    gh api -X DELETE "repos/$REPO/issues/$N/assignees" -f "assignees[]=$ME"
    echo "claim: lost the checkpoint tiebreak on #$N — backing off." >&2
    exit 3; }
  # claim won and confirmed → triage this issue (Steps 1–6), then RELEASE in Step 6
  echo "claim: won #$N"
else
  # lost the tiebreak: self-clean and take the next issue (do NOT triage — do NOT co-occupy)
  gh api -X DELETE "repos/$REPO/issues/$N/assignees" -f "assignees[]=$ME"
  echo "claim: lost the min-login tiebreak on #$N to '$WINNER' — backing off." >&2
  exit 3
fi
