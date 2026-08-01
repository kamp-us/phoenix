#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2086
# Disambiguate an empty check set: CI green with no gating checks vs a head no run ever fired for.
#
# Extracted VERBATIM from ship-it/SKILL.md's Step 3 fenced block (epic #4435 phase 1, #4448).
# A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2 (#1929).
#
# DUAL-MODE (ADR 0232) — the why is `.patterns/skill-script-shell-shape.md` § The dual-mode shape.
#   EXECUTED:  bash ./claude-plugins/kampus-pipeline/skills/ship-it/scripts/step3-empty-checkset-probe.sh <REPO> <PR>
#              stdout ⇒ three lines — `HEAD_SHA=<40-hex>`, `NWF=<n>`, `NRUNS=<n>` — the values the
#              sourced form left in the caller's shell. Both counts already carry their fail-safe
#              substitute when the lookup itself failed, so the printed number is always the number
#              the Step-3z branch is meant to read.
#   SOURCED:   no in-script consumer today; the edge stays open for one.
# No EXIT trap — under bash 3.2 a cleanup trap's last command becomes the script's status,
# laundering a `set -u` abort into exit 0 (#4476, class #4479).

if [ "${BASH_SOURCE[0]}" = "$0" ]; then set -uo pipefail; fi   # executed mode only (ADR 0232)
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

REPO="${REPO:-${1:?step3-empty-checkset-probe.sh: REPO unset and no \$1 — refusing to probe an unnamed repo}}"
PR="${PR:-${2:?step3-empty-checkset-probe.sh: PR unset and no \$2 — refusing to probe an unnamed PR}}"

HEAD_SHA=$(gh api repos/$REPO/pulls/$PR --jq '.head.sha')
# (a) Does this repo run Actions at all? A CI-less / foreign repo's empty check set is genuine,
#     not a dropped trigger — it degrades to the PASS-only path (Step 3.5 portability), no nudge.
NWF=$(gh api "repos/$REPO/actions/workflows?per_page=100" --jq '.workflows | length' 2>/dev/null)
# (b) Workflow runs recorded for THIS exact head SHA (the same head_sha bind Step 3.5 uses).
NRUNS=$(gh api "repos/$REPO/actions/runs?head_sha=$HEAD_SHA&per_page=100" \
  --jq '.workflow_runs | length' 2>/dev/null)
# An empty capture = the lookup itself failed (network/auth/rate-limit), NOT a confirmed zero —
# never nudge on an unconfirmed absence: assume "runs exist" / "no Actions", fall through, and
# let the Step 3.5 backstop guard the merge.
# `if … fi`, not `[ … ] && VAR=…`: the ORDINARY case is a lookup that succeeded, which makes the
# `[ -z … ]` test FALSE — and as the last command of the script that would leave the exit status at
# 1 on the very reads that worked (`.patterns/skill-script-shell-shape.md` § The dual-mode shape
# rule 4). The substitutions themselves are unchanged.
if [ -z "$NRUNS" ]; then NRUNS=1; fi
if [ -z "$NWF" ]; then NWF=0; fi

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  printf 'HEAD_SHA=%s\n' "$HEAD_SHA"
  printf 'NWF=%s\n' "$NWF"
  printf 'NRUNS=%s\n' "$NRUNS"
fi
