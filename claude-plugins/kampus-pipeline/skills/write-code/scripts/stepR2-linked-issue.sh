#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2016,SC2086
# Step R2: resolve the PR's linked issue #N, then read its body and comment stream.
#
# Extracted VERBATIM from write-code/SKILL.md's Step R2 fenced block (epic #4435 phase 1, #4449).
# A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2 (#1929).
#
# SOURCED, never executed: leaving $N in the sourcing shell is the whole point — every later repair
# mutation gates on `claim_is_mine "$N"`. Sets NO shell options; no EXIT trap (#4476, class #4479).
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

N=$(gh api repos/$REPO/pulls/$PR \
  --jq '.body | capture("(?i)\\b(fix(es|ed)?|close[sd]?|resolve[sd]?)\\s+#(?<n>[0-9]+)") | .n')
gh api repos/$REPO/issues/$N --jq '.body'
gh api "repos/$REPO/issues/$N/comments?per_page=100" --jq '.[].body'
