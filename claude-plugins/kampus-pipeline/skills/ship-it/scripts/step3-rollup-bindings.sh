#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2034,SC2086
# Read the head's check state ONCE and bind the rollup's pending/failing sets — Step 3's classifier
# input. `read_head_ci` is left defined for the settle poll, which re-reads the head through it.
#
# Extracted VERBATIM from ship-it/SKILL.md's Step 3 fenced block (epic #4435 phase 1, #4448/#4498).
# A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2 (#1929).
#
# SOURCED, never executed. The fenced block it replaces ran inline in the agent's shell, so this
# file deliberately sets NO shell options — several guards here depend on `pipefail` being OFF —
# and leaves its variables and functions in the sourcing shell, which is how the step's later
# blocks still see them. The bare `exit 0` on an unreadable head is therefore the SHIPPER's exit,
# which is the intended disposition: an unreadable head is never enqueued.
#
# PARSER-HELD (#4498): `checks/step3-contract.ts` reads the `VAR=$(jq -r '.field …)` bindings below
# out of Step 3's surface to derive the branch-2 pending predicate. It reaches them by following
# SKILL.md's source line into this file, so keep the bindings at column 0 and keep that source line
# inside the `## Step 3 — ` section.
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

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
  echo "refused — head CI unreadable (typed unknown) — not enqueued"; exit 0
}

# The aggregate `.conclusion` is deliberately NOT bound here: it is a colour in which red wins over
# pending, so classifying off it lets an informational red mask an unfinished check (see below).
CONTEXTS=$(jq -r '.contexts'    <<<"$CI_JSON")   # how many contexts the rollup covered
RUNNING=$(jq -r  '.running | join(", ")' <<<"$CI_JSON")   # genuinely in flight — these settle
WEDGED=$(jq -r   '.wedged  | join(", ")' <<<"$CI_JSON")   # queued, never started — these do NOT
# The known-informational carve-out, applied to the failing set (names below).
GATING_RED=$(jq -r '[.failing[]
  | select(. != "deploy (web)" and (startswith("cleanup (web,") | not))] | join(", ")' <<<"$CI_JSON")
