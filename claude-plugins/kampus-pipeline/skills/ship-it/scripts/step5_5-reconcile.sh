#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2034,SC2086
# The bounded post-enqueue reconcile — QUEUED is not terminal success (#1906/#1921/#4403).
#
# Extracted VERBATIM from ship-it/SKILL.md's Step 5.5 fenced block (epic #4435 phase 1,
# #4448/#4498). A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is
# phase 2 (#1929).
#
# DUAL-MODE (ADR 0232) — the why is `.patterns/skill-script-shell-shape.md` § The dual-mode shape.
#   EXECUTED:  bash ./claude-plugins/kampus-pipeline/skills/ship-it/scripts/step5_5-reconcile.sh <REPO> <PR>
#              stdout ⇒ `MERGE_OUTCOME=<merged|queued|pending|ejected>`, `RECONCILE_HORIZON=<secs>`,
#              `INTENT_UNCLEARED=<0|1>`, and `MERGE_DISPOSITION=<text>` — the four values the ledger
#              renders, which the sourced form left in the caller's shell. `MERGE_DISPOSITION` is
#              printed LAST because it is the only multi-word one, so a reader can take the rest of
#              the line verbatim. An unresolved shim prints NONE of them and exits 1: a reconcile
#              that never ran is UNKNOWN, not `pending`.
#   SOURCED:   no in-script consumer today; the edge stays open for one.
#
# PARSER-HELD (#4498): `merge-queue-classify/step55-contract.ts` reads the RECONCILE_TRIES /
# RECONCILE_SLEEP defaults, the between-polls sleep guard, and the MERGE_DISPOSITION case arms out
# of Step 5.5's surface. It reaches them by following SKILL.md's source line into this file, so keep
# those bindings at column 0 and keep that INVOCATION inside the `### Step 5.5 — ` section.
# (`reachedScriptNames` learned the ADR-0232 literal-path form alongside the old `$SHIPIT_SCRIPTS/`
# one, so the follow still resolves.)
if [ "${BASH_SOURCE[0]}" = "$0" ]; then set -uo pipefail; fi   # executed mode only (ADR 0232)
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"
# `disarm_intent` (guard 6 / ADR 0198), sourced IN-CHAIN — a process inherits no functions (ADR 0232).
# shellcheck source=disarm-intent.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/." && pwd)/disarm-intent.sh"

# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/bin/pipeline-cli"
REPO="${REPO:-${1:?step5_5-reconcile.sh: REPO unset and no \$1 — refusing to reconcile in an unnamed repo}}"
PR="${PR:-${2:?step5_5-reconcile.sh: PR unset and no \$2 — refusing to reconcile an unnamed PR}}"
# …and prove it resolved before polling. An unresolved CLI prints nothing, so every poll would
# read as neither `merged` nor `ejected`, the budget would exhaust, and the run would report a
# well-formed `pending` for a classifier that never ran — a could-not-run posing as an answer
# (§CLI / §WL; #3314). UNKNOWN is the only honest outcome here.
[ -x "$PCLI" ] || {
  echo "ship-it: merge-queue-classify is UNRESOLVED at '$PCLI' — the reconcile outcome is UNKNOWN, NOT pending. Re-resolve the CLI and re-poll; do not report a merge outcome." >&2
  exit 1
}
# Bounded reconcile: poll the authoritative merge-queue state within a batch window, then classify.
# BOUNDED, not synchronous-to-merge (ADR 0132): a fixed budget of polls, then STOP and report —
# a PR still QUEUED at the budget's end is a well-formed pending, not a failure.
# The classifier reads PR state (gh pr view — the sanctioned PR-state read ship-it Step 2 uses,
# NOT a GraphQL intake query the org's Projects-classic integration breaks) + the last merge-queue
# timeline event AND whether a `merged` event is present (gh api …/timeline, REST — the pairing
# that tells a consumed queue entry from an ejection, #4155), cross-checks a non-merged read against the base branch
# (gh api …/commits?sha=<base>, the read that stayed fresh while the other two lagged — #4057), and
# prints merged/ejected/queued/pending. It is fail-closed away from a false ship: any unreadable
# signal ⇒ pending (keep polling), never a false merged/ejected.
# The budget, and the ONE number the stand-down must report: the OBSERVATION HORIZON. Poll k fires
# at (k-1)*SLEEP, so what the run actually watched is (TRIES-1)*SLEEP — not TRIES*SLEEP. The old
# 10x30s pair observed to 4m30s while every sampled merge-queue dwell on this repo ran 5m17s–9m25s
# (n=10, median 6m27s, mean 6m37s — #4403), so the budget expired mid-dwell on 10 of 10 merges, and
# the trailing sleep after the last poll burned 30s observing nothing. 16x30s puts the horizon at
# 7m30s, past both the median and the mean; it is NOT set past the 9m25s max because one shipper
# invocation has a ~10-minute wall-clock ceiling and the 16 polls' own `gh` latency eats into it.
# That ceiling is what makes over-widening WORSE than standing down: a run killed against it
# mid-loop never reaches the ledger at all, so it emits no `merge:` line — silence, where a
# stand-down would at least have stated the bound of what it watched.
# So even the widened horizon can expire mid-dwell — which is exactly why the widening is the
# secondary fix and the honest stand-down wording below is the primary one.
RECONCILE_TRIES=${SHIP_RECONCILE_TRIES:-16}
RECONCILE_SLEEP=${SHIP_RECONCILE_SLEEP:-30}
RECONCILE_HORIZON=$(( (RECONCILE_TRIES - 1) * RECONCILE_SLEEP ))   # seconds ACTUALLY observed
MERGE_OUTCOME=pending
for i in $(seq 1 "$RECONCILE_TRIES"); do
  MERGE_OUTCOME=$("$PCLI" merge-queue-classify classify --pr "$PR" --repo "$REPO")
  [ "$MERGE_OUTCOME" = merged ] && break   # terminal success
  [ "$MERGE_OUTCOME" = ejected ] && break  # a genuine dequeue (removed_from_merge_queue) — act below
  # queued (still in the queue) or pending (enqueue-settle window) ⇒ keep polling within the budget.
  # Sleep only BETWEEN polls: a trailing sleep after the last poll observes nothing, and only makes
  # the reported horizon overstate the reach of the observation.
  if [ "$i" -lt "$RECONCILE_TRIES" ]; then sleep "$RECONCILE_SLEEP"; fi
done
# At the budget's end a still-`pending` PR (never a merge-queue event) is reported as a well-formed
# pending, NOT ejected — the settle window is not an ejection (#1921).

# The run's merge disposition, single-sourced HERE and emitted verbatim as the ledger's `merge:`
# line. Budget exhaustion while the PR is still in the queue is UNRESOLVED — genuinely unknown, and
# neither a landing nor a failure — so it is worded as the bounded observation it is, carrying the
# horizon it watched. The three renderings stay textually distinct (#4403).
case "$MERGE_OUTCOME" in
  merged)
    MERGE_DISPOSITION="landed (queue merged the batch)" ;;
  queued|pending)
    MERGE_DISPOSITION="UNRESOLVED — still queued at my last read, ~${RECONCILE_HORIZON}s after enqueue; the merge may still land. Bounded observation, not a failure and not a landing — an independent later read closes the lane." ;;
  ejected)
    MERGE_DISPOSITION="EJECTED (routed to repair/re-queue)" ;;
  *)
    # Unreachable while the classifier prints one of its four words — which is exactly why it is
    # here: without it an unrecognized $MERGE_OUTCOME leaves MERGE_DISPOSITION unset and the
    # ledger's `merge:` line renders BLANK — a could-not-determine posing as nothing at all.
    MERGE_DISPOSITION="UNKNOWN — the reconcile produced no recognized outcome word; the merge state was never determined. Not a landing, not a failure, not an ejection — re-read the PR before acting on it." ;;
esac

# Guard 6 (ADR 0198) — the reconcile's terminal read is the LAST place this run can leave an arm
# behind, so it is also sites 3 and 4. `merged` and `queued` keep the intent (a live queue entry is
# never disturbed); an `ejected` PR is cleared so a re-approval after its rebase cannot re-enqueue
# it ahead of a fresh gate pass; and an arm that never became a queue entry on a QUEUE-GOVERNED
# base branch is a PARKED intent — `merge-intent` reads the base branch's ruleset to tell the two
# regimes apart, so a repo whose base branch has no merge queue keeps its legitimate armed
# auto-merge while this repo's every unqueued arm is cleared.
if [ "$MERGE_OUTCOME" = ejected ]; then
  disarm_intent ejected || INTENT_UNCLEARED=1
else
  INTENT_ACTION=$("$PCLI" merge-intent disarm --pr "$PR" --repo "$REPO" --site post-enqueue) || INTENT_UNCLEARED=1
  # `if … fi`: the ORDINARY outcome is an intent that was NOT a parked arm — i.e. this test being
  # FALSE — and as the branch's last command that failing test became the script's exit status, so
  # every clean reconcile would report itself UNKNOWN under §SHARED's read-the-status-first rule
  # (`.patterns/skill-script-shell-shape.md` § The dual-mode shape rule 4). The predicate is unchanged.
  if [ "$INTENT_ACTION" = disarmed ]; then
    echo "refused — the enqueue did not take effect at this head; the parked intent was cleared. Re-dispatch ship-it to re-assert the gates and enqueue (idempotent)."
  fi
fi

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  printf 'MERGE_OUTCOME=%s\n' "$MERGE_OUTCOME"
  printf 'RECONCILE_HORIZON=%s\n' "$RECONCILE_HORIZON"
  printf 'INTENT_UNCLEARED=%s\n' "$INTENT_UNCLEARED"
  printf 'MERGE_DISPOSITION=%s\n' "$MERGE_DISPOSITION"
fi
