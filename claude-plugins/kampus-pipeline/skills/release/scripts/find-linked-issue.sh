#!/usr/bin/env bash
# Step 1: find the `status:awaiting-release` issue whose closing PR body carried `Flag: <key>` for
# THIS flag key — the queue entry Steps 4 and 5 dequeue and annotate.
#
# usage: find-linked-issue.sh <flag-key>
#   stdout  one `match: issue #<I> ← PR #<P> declares Flag: <key>` line per match
#   exit 0  at least one match — read them; MORE THAN ONE is the ambiguous case the skill sends to
#           the human, so count the lines rather than taking the first
#   exit 4  the search ran and found ZERO matches (a PROVEN empty queue, not a failed read)
#   exit 1/2  could not run — UNKNOWN. Never read as "no queue entry": exit 4 is the only zero-match
#           answer, so a failed read can't route the caller into skipping Step 4 (the wrong-dequeue
#           and silent-skip hazards the prose names).
#
# Extracted from release/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: find-linked-issue.sh <flag-key>" >&2; exit 2; }
FLAG_KEY="$1"
REPO="$(kp_repo)" || exit 1

MATCHES=0
# candidate issues on the release queue (the label persists on the closed, linked issue; #602)
for ISSUE in $(gh api "repos/$REPO/issues?state=all&labels=status:awaiting-release&per_page=100" \
    --jq '.[] | select(.pull_request | not) | .number'); do
  # find the PR(s) that closed this issue and check each body for a `Flag: <key>` line naming THIS key
  # (the grammar write-code Step 5 writes and ship-it Step 5b reads)
  # --paginate + a STREAMING --jq: per_page caps at 100, so the closing PR of an issue with a
  # long timeline would otherwise fall off the read and drop the flag from the release queue (#4193)
  for PR in $(gh api --paginate "repos/$REPO/issues/$ISSUE/timeline?per_page=100" \
      --jq '.[] | select(.event=="cross-referenced" or .event=="closed")
                | .source.issue.number? // empty' 2>/dev/null | sort -u); do
    body=$(gh api "repos/$REPO/pulls/$PR" --jq '.body // ""' 2>/dev/null)
    if printf '%s' "$body" \
      | grep -Eiq "^[[:space:]]*(#{1,6}[[:space:]]*)?\**[[:space:]]*flag([[:space:]]*key)?:[[:space:]]*\**[[:space:]]*${FLAG_KEY}([[:space:]]|$)"; then
      echo "match: issue #$ISSUE ← PR #$PR declares Flag: $FLAG_KEY"
      MATCHES=$((MATCHES + 1))
    fi
  done
done

[ "$MATCHES" -gt 0 ] || { echo "release: no status:awaiting-release issue names Flag: $FLAG_KEY (searched the whole queue)." >&2; exit 4; }
