#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2034,SC2086
# Read the head's check state ONCE and bind the rollup's pending/failing sets — Step 3's classifier
# input. `read_head_ci` is left defined for the settle poll, which re-reads the head through it.
#
# Extracted VERBATIM from ship-it/SKILL.md's Step 3 fenced block (epic #4435 phase 1, #4448/#4498).
# A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2 (#1929).
#
# DUAL-MODE (ADR 0232) — the why is `.patterns/skill-script-shell-shape.md` § The dual-mode shape.
#   EXECUTED:  bash ./claude-plugins/kampus-pipeline/skills/ship-it/scripts/step3-rollup-bindings.sh <REPO> <PR>
#              stdout ⇒ four lines — `CONTEXTS=<n>`, `RUNNING=<names>`, `WEDGED=<names>`,
#              `GATING_RED=<names>` — the classifier input the sourced form left in the caller's
#              shell. An unreadable head prints NONE of them and instead prints the `refused — head
#              CI unreadable …` line plus `INTENT_UNCLEARED=<0|1>`; that is a successful DECLINE, so
#              it exits 0 exactly as the fenced block did. Read the presence of `CONTEXTS=`, never
#              the exit status, to tell an answer from a decline here.
#   SOURCED:   the sanctioned in-script edge — `step3-ci-settle-wait.sh` sources this file for
#              `read_head_ci`, which no longer reaches it through the agent's shell (ADR 0232).
#
# PARSER-HELD (#4498): `checks/step3-contract.ts` reads the `VAR=$(jq -r '.field …)` bindings below
# out of Step 3's surface to derive the branch-2 pending predicate. It reaches them by following
# SKILL.md's INVOCATION line into this file, so keep the bindings at column 0 and keep that
# invocation inside the `## Step 3 — ` section. (`sourcedScriptNames` learned the ADR-0232
# literal-path form alongside the old `$SHIPIT_SCRIPTS/` one, so the follow still resolves.)
if [ "${BASH_SOURCE[0]}" = "$0" ]; then set -uo pipefail; fi   # executed mode only (ADR 0232)
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"
# `disarm_intent` (guard 6 / ADR 0198), sourced IN-CHAIN — a process inherits no functions (ADR 0232).
# shellcheck source=disarm-intent.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/." && pwd)/disarm-intent.sh"

REPO="${REPO:-${1:?step3-rollup-bindings.sh: REPO unset and no \$1 — refusing to read CI in an unnamed repo}}"
PR="${PR:-${2:?step3-rollup-bindings.sh: PR unset and no \$2 — refusing to read CI on an unnamed PR}}"

CHECKS="${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/bin/pipeline-cli checks"

# Echo the rollup JSON; return 0 readable · 2 UNKNOWN (refuse — never a colour, never green).
read_head_ci() {
  local out rc conclusion
  out="$($CHECKS read --pr "$PR" --expect green 2>/dev/null)"; rc=$?
  # SHAPE-CHECK BEFORE INTERPRETING: an error body / truncated capture is not data. Exit 2 is the
  # verb's own typed unknown; a body with no readable `conclusion` is treated identically.
  conclusion="$(printf '%s' "$out" | jq -r '.conclusion? // empty' 2>/dev/null)"
  case "$rc:$conclusion" in
    0:green|1:red|1:pending) printf '%s' "$out"; return 0 ;;
    *) return 2 ;;
  esac
}

CI_JSON="$(read_head_ci)" || {
  disarm_intent refuse || INTENT_UNCLEARED=1   # guard 6: this stop does not enqueue — park nothing
  gh api "repos/$REPO/issues/$PR/comments" -f body="ship-it: refused — head CI **unreadable** (the check-runs read returned no interpretable state) — **not enqueued**. An unreadable head is not a green head; re-dispatch ship-it once the API is answering — idempotent (#3999)." >/dev/null
  echo "refused — head CI unreadable (typed unknown) — not enqueued"
  printf 'INTENT_UNCLEARED=%s\n' "$INTENT_UNCLEARED"   # the ledger must name a decline that left the intent armed
  exit 0
}

# The aggregate `.conclusion` is deliberately NOT bound here: it is a colour in which red wins over
# pending, so classifying off it lets an informational red mask an unfinished check (see below).
CONTEXTS=$(jq -r '.contexts'    <<<"$CI_JSON")   # how many contexts the rollup covered
RUNNING=$(jq -r  '.running | join(", ")' <<<"$CI_JSON")   # genuinely in flight — these settle
WEDGED=$(jq -r   '.wedged  | join(", ")' <<<"$CI_JSON")   # queued, never started — these do NOT
# The known-informational carve-out, applied to the failing set (names below).
GATING_RED=$(jq -r '[.failing[]
  | select(. != "deploy (web)" and (startswith("cleanup (web,") | not))] | join(", ")' <<<"$CI_JSON")

# An EMPTY $RUNNING / $WEDGED / $GATING_RED is the ordinary all-green answer, so each line is printed
# unconditionally — an absent line would be indistinguishable from a decline (rule 4 / §ZS).
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  printf 'CONTEXTS=%s\n' "$CONTEXTS"
  printf 'RUNNING=%s\n' "$RUNNING"
  printf 'WEDGED=%s\n' "$WEDGED"
  printf 'GATING_RED=%s\n' "$GATING_RED"
fi
