#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2034,SC2086
# The bounded CI-settle poll — never a silent park (#1928).
#
# Extracted VERBATIM from ship-it/SKILL.md's Step 3 fenced block (epic #4435 phase 1, #4448).
# A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2 (#1929).
#
# SOURCED, never executed. The fenced block it replaces ran inline in the agent's shell, so this
# file deliberately sets NO shell options — several guards here depend on `pipefail` being OFF —
# and leaves its variables and functions in the sourcing shell, which is how the step's later
# blocks still see them.
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

SETTLE_BUDGET_SECS="${SHIP_IT_SETTLE_BUDGET_SECS:-600}"    # total in-process wait ceiling — BOUNDED, never unbounded
SETTLE_INTERVAL_SECS="${SHIP_IT_SETTLE_INTERVAL_SECS:-30}" # cadence; each pass emits progress so a no-progress watchdog never fires
WEDGE_DWELL_SECS="${SHIP_IT_WEDGE_DWELL_SECS:-120}"        # how long an all-wedged pending set must persist before it is called wedged
ci_settle_wait() {   # returns 0=settled-green→enqueue · 1=refused (budget-exhausted, wedged, OR head moved mid-settle; comment posted) · 2=gating red mid-wait→heal-ci
  local waited=0 wedged_for=0 json red pending wedged running headnow
  while :; do
    # The SAME read as Step 3 — REST check-runs through `pipeline-cli checks read`, never
    # `gh pr checks` (#3999). An unreadable head refuses here exactly as it does at Step 3.
    json="$(read_head_ci)" || {
      disarm_intent refuse || INTENT_UNCLEARED=1
      gh api "repos/$REPO/issues/$PR/comments" -f body="ship-it: refused — head CI became **unreadable** during the CI-settle wait — **not enqueued**. An unreadable head is not a green head; re-dispatch ship-it — idempotent (#3999)." >/dev/null
      echo "refused — head CI unreadable mid-settle — not enqueued"; return 1
    }
    # same known-informational carve-out as Step 3: a red preview-deploy/teardown check never gates
    red="$(jq -r '[.failing[] | select(. != "deploy (web)" and (startswith("cleanup (web,") | not))] | join(" ")' <<<"$json")"
    running="$(jq -r '.running | join(" ")' <<<"$json")"
    wedged="$(jq -r  '.wedged  | join(" ")' <<<"$json")"
    pending="$(jq -r '(.running + .wedged) | join(" ")' <<<"$json")"
    if [ -n "$red" ]; then
      disarm_intent refuse || INTENT_UNCLEARED=1   # guard 6: this wait ends without an enqueue — park nothing
      echo "gating check went red during settle-wait ($red) — routing to heal-ci"; return 2
    fi
    if [ -z "$pending" ]; then
      # TOCTOU guard (secondary #1928 note): the in-process poll widens the window between Step 2/2b's
      # SHA-bound verdict check (bound to $CURRENT_HEAD) and the enqueue. Unlike the old park→fresh-reinvoke
      # (which re-ran Step 2b on resume), this in-process resume enters at Step 3.5 and does NOT re-run
      # Step 2b — so a head-move during the settle would enqueue a head whose verdict/run-evidence predate
      # it. Re-confirm the head is still the verified one before returning green; if it moved, refuse (same
      # durable-comment/stop disposition as budget-exhaustion) so a re-dispatch re-runs Step 2b on the moved head.
      headnow="$(gh api repos/$REPO/pulls/$PR --jq '.head.sha')"
      if [ -n "$headnow" ] && [ "$headnow" != "$CURRENT_HEAD" ]; then
        disarm_intent refuse || INTENT_UNCLEARED=1   # guard 6: a moved head invalidates the intent exactly as it does the verdict (ADR 0198/0058)
        gh api "repos/$REPO/issues/$PR/comments" -f body="ship-it: refused — head moved during CI-settle (verified ${CURRENT_HEAD}, now ${headnow}) — **not enqueued**. The SHA-bound verdict and run-evidence (Step 2/2b) predate this head; re-dispatch ship-it to re-verify the moved head — idempotent, a re-ship on a re-verified head enqueues cleanly (#1928)." >/dev/null
        echo "refused — head moved during settle-wait (${CURRENT_HEAD} → ${headnow}); Step 2b must re-run — not enqueued"; return 1
      fi
      echo "gating checks settled green after ${waited}s — proceeding to Step 3.5 → enqueue"; return 0
    fi
    # WEDGED: everything unfinished is queued-and-never-started. Such a run does not start on its
    # own, so the remaining budget cannot clear it — refuse once the state has held for the dwell
    # (a check queued seconds ago is normal; one queued with no start time for minutes is stuck).
    if [ -n "$wedged" ] && [ -z "$running" ]; then
      wedged_for=$((wedged_for + SETTLE_INTERVAL_SECS))
    else
      wedged_for=0
    fi
    if [ "$wedged_for" -ge "$WEDGE_DWELL_SECS" ]; then
      disarm_intent refuse || INTENT_UNCLEARED=1   # guard 6: this wait ends without an enqueue — park nothing
      gh api "repos/$REPO/issues/$PR/comments" -f body="ship-it: refused — CI **wedged (stranded in queue)** for ${wedged_for}s — **not enqueued**. These gating checks are \`queued\` with no start time and are not running: ${wedged}. A wedged run does not start on its own, so waiting the ${SETTLE_BUDGET_SECS}s settle budget out cannot clear it — this is reported as its own state rather than waited out (#3999). Operator lever (deliberately NOT automated — see the skill): cancel the stuck workflow run, then re-run it (a plain rerun on a still-queued run returns 403):
\`\`\`
RUN=\$(gh api \"repos/$REPO/actions/runs?head_sha=$CURRENT_HEAD&per_page=100\" --jq '.workflow_runs[] | select(.status==\"queued\") | .id')
gh api -X POST \"repos/$REPO/actions/runs/\$RUN/cancel\" && gh api -X POST \"repos/$REPO/actions/runs/\$RUN/rerun\"
\`\`\`
Re-dispatch ship-it once the re-run settles — idempotent, a re-ship on the now-green head enqueues cleanly." >/dev/null
      echo "refused — CI wedged (stranded in queue: ${wedged}) after ${wedged_for}s — not enqueued"; return 1
    fi
    if [ "$waited" -ge "$SETTLE_BUDGET_SECS" ]; then
      disarm_intent refuse || INTENT_UNCLEARED=1   # guard 6: the budget ran out without an enqueue — park nothing
      # Budget exhausted, still pending → the ONE required durable signal: an explicit PR-visible refusal.
      # A plain outcome note, NOT a review-* verdict marker — so it never blocks a later idempotent re-ship.
      gh api "repos/$REPO/issues/$PR/comments" -f body="ship-it: refused — CI still pending after ${SETTLE_BUDGET_SECS}s (still running: ${running:-none}; wedged in queue: ${wedged:-none}) — **not enqueued**. This head is not yet merge-ready; re-dispatch ship-it once CI settles — idempotent, a re-ship on the now-green head enqueues cleanly (#1928)." >/dev/null
      echo "refused — CI still pending after ${SETTLE_BUDGET_SECS}s (PR outcome comment posted) — not enqueued"; return 1
    fi
    echo "checks still pending after ${waited}s (running: ${running:-none}; wedged: ${wedged:-none}) — re-reading in ${SETTLE_INTERVAL_SECS}s (budget ${SETTLE_BUDGET_SECS}s)"
    sleep "$SETTLE_INTERVAL_SECS"; waited=$((waited + SETTLE_INTERVAL_SECS))
  done
}

ci_settle_wait; SETTLE_RC=$?
case "$SETTLE_RC" in
  0) : ;;         # settled green → fall through to Step 3.5 → Step 4 (enqueue)
  2)              # gating red mid-wait → route to /heal-ci (Step 3 branch 1's disposition), then STOP — never enqueue.
     # This arm MUST terminate the ship, exactly like `1)`: a check that goes red DURING the poll is a
     # gating red, and Step 3 branch 1's disposition is "do NOT merge; invoke /heal-ci and report." Invoke
     # /heal-ci for this PR (the same agent action Step 3 branch 1 takes), then exit — falling through here
     # would enqueue a red PR, the exact merge-safety hole this arm exists to close (#1928).
     echo "routed to heal-ci — gating check went red mid-settle for PR #$PR; not enqueued"; exit 0 ;;
  1) exit 0 ;;    # refused (budget-exhausted, wedged in queue, head moved mid-settle, or unreadable) — durable outcome comment posted; a successful decline, no longer silent (#1928)
esac
