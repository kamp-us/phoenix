#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1091,SC2034,SC2154
# Disambiguate an empty check set: CI green with no gating checks vs a head no run ever fired for.
#
# Extracted VERBATIM from ship-it/SKILL.md's Step 3 fenced block (epic #4435 phase 1, #4448).
# A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2 (#1929).
#
# SOURCED, never executed. The fenced block it replaces ran inline in the agent's shell, so this
# file deliberately sets NO shell options — several guards here depend on `pipefail` being OFF —
# and leaves its variables and functions in the sourcing shell, which is how the step's later
# blocks still see them.
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

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
[ -z "$NRUNS" ] && NRUNS=1
[ -z "$NWF" ]   && NWF=0
