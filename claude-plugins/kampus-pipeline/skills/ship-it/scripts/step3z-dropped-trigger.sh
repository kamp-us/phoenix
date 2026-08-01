#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2034
# The dropped-trigger state (zero workflow runs for the head) and its bounded nudge.
#
# Extracted VERBATIM from ship-it/SKILL.md's Step 3z fenced block (epic #4435 phase 1, #4448).
# A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2 (#1929).
#
# DUAL-MODE (ADR 0232) — the why is `.patterns/skill-script-shell-shape.md` § The dual-mode shape.
#   EXECUTED:  bash ./claude-plugins/kampus-pipeline/skills/ship-it/scripts/step3z-dropped-trigger.sh \
#                   <REPO> <PR> <HEAD_SHA>
#              stdout ⇒ one terminal line — `nudged (close→reopen) …` or `unverified (no runs fired
#              …)` — plus `INTENT_UNCLEARED=<0|1>`. Both are successful declines and exit 0, exactly
#              as the fenced block did; read the terminal word, not the status.
#              `<HEAD_SHA>` is the head `step3-empty-checkset-probe.sh` printed — the nudge counts
#              `reopened` events since THAT commit, so a guessed head would mis-count them.
#   SOURCED:   no in-script consumer today; the edge stays open for one.
# No EXIT trap — under bash 3.2 a cleanup trap's last command becomes the script's status,
# laundering a `set -u` abort into exit 0 (#4476, class #4479).

if [ "${BASH_SOURCE[0]}" = "$0" ]; then set -uo pipefail; fi   # executed mode only (ADR 0232)
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"
# `disarm_intent` (guard 6 / ADR 0198), sourced IN-CHAIN — a process inherits no functions (ADR 0232).
# shellcheck source=disarm-intent.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/." && pwd)/disarm-intent.sh"

REPO="${REPO:-${1:?step3z-dropped-trigger.sh: REPO unset and no \$1 — refusing to nudge an unnamed repo}}"
PR="${PR:-${2:?step3z-dropped-trigger.sh: PR unset and no \$2 — refusing to nudge an unnamed PR}}"
HEAD_SHA="${HEAD_SHA:-${3:?step3z-dropped-trigger.sh: HEAD_SHA unset and no \$3 — refusing to count nudges against an unnamed head}}"

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
  echo "unverified (no runs fired — nudge exhausted, producer may be stuck)"   # refuse, hand to human
  if [ "${BASH_SOURCE[0]}" = "$0" ]; then printf 'INTENT_UNCLEARED=%s\n' "$INTENT_UNCLEARED"; fi
  exit 0
fi

# First (and only) nudge for this head: close then reopen over REST (never `gh pr close/reopen`
# or `gh pr edit` — Projects-classic breaks their GraphQL path in this org). The head ref is
# untouched, so every SHA-bound review verdict (Step 2) survives the reopen.
gh api -X PATCH "repos/$REPO/pulls/$PR" -f state=closed >/dev/null
gh api -X PATCH "repos/$REPO/pulls/$PR" -f state=open   >/dev/null
# Durable, PR-visible outcome so the park is observable (#1928): a re-dispatch after CI settles resumes the ship.
gh api "repos/$REPO/issues/$PR/comments" -f body="ship-it: nudged (close→reopen) — CI re-triggered, **not enqueued** yet. The head SHA had zero workflow runs (dropped trigger); ship-it close→reopened it once to re-emit the trigger. Re-dispatch ship-it once CI settles — idempotent (#1928)." >/dev/null
echo "nudged (close→reopen) — CI re-triggered, not yet merge-ready"   # stop; re-dispatch after CI settles resumes the ship
if [ "${BASH_SOURCE[0]}" = "$0" ]; then printf 'INTENT_UNCLEARED=%s\n' "$INTENT_UNCLEARED"; fi
exit 0
