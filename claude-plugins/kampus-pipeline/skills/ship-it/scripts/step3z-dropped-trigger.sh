#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2034
# The dropped-trigger state (zero workflow runs for the head) and its bounded nudge.
#
# Extracted VERBATIM from ship-it/SKILL.md's Step 3z fenced block (epic #4435 phase 1, #4448).
# A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2 (#1929).
#
# SOURCED, never executed. The fenced block it replaces ran inline in the agent's shell, so this
# file deliberately sets NO shell options — several guards here depend on `pipefail` being OFF —
# and leaves its variables and functions in the sourcing shell, which is how the step's later
# blocks still see them.
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

# Have we ALREADY nudged this exact head? A nudge leaves a `reopened` event; count the ones
# that landed AFTER this head SHA was pushed (its committer date is the proxy for "since this
# commit"). >=1 ⇒ we already close→reopened this head and runs STILL didn't fire ⇒ the producer
# is genuinely stuck, not a dropped webhook ⇒ do NOT nudge again — refuse and hand to a human.
HEAD_PUSHED=$(gh api "repos/$REPO/commits/$HEAD_SHA" --jq '.commit.committer.date')
NUDGES=$(gh api "repos/$REPO/issues/$PR/events?per_page=100" \
  --jq "[.[] | select(.event==\"reopened\") | .created_at | select(. > \"$HEAD_PUSHED\")] | length")

disarm_intent refuse || INTENT_UNCLEARED=1   # guard 6: BOTH exits below stop without enqueuing — park nothing (ADR 0198)

if [ "${NUDGES:-0}" -ge 1 ]; then
  # Nudge exhausted → refuse and hand to a human, but leave a durable PR-visible signal (#1928):
  # never a silent stop even on this dead-end path.
  gh api "repos/$REPO/issues/$PR/comments" -f body="ship-it: unverified (no runs fired — nudge exhausted, producer may be stuck) — **not enqueued**. This head was already close→reopened once and CI still fired zero runs; handing to a human (#1928)." >/dev/null
  echo "unverified (no runs fired — nudge exhausted, producer may be stuck)"; exit 0   # refuse, hand to human
fi

# First (and only) nudge for this head: close then reopen over REST (never `gh pr close/reopen`
# or `gh pr edit` — Projects-classic breaks their GraphQL path in this org). The head ref is
# untouched, so every SHA-bound review verdict (Step 2) survives the reopen.
gh api -X PATCH "repos/$REPO/pulls/$PR" -f state=closed >/dev/null
gh api -X PATCH "repos/$REPO/pulls/$PR" -f state=open   >/dev/null
# Durable, PR-visible outcome so the park is observable (#1928): a re-dispatch after CI settles resumes the ship.
gh api "repos/$REPO/issues/$PR/comments" -f body="ship-it: nudged (close→reopen) — CI re-triggered, **not enqueued** yet. The head SHA had zero workflow runs (dropped trigger); ship-it close→reopened it once to re-emit the trigger. Re-dispatch ship-it once CI settles — idempotent (#1928)." >/dev/null
echo "nudged (close→reopen) — CI re-triggered, not yet merge-ready"; exit 0   # stop; re-dispatch after CI settles resumes the ship
