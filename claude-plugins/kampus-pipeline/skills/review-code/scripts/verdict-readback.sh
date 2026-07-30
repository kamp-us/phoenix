#!/usr/bin/env bash
# Step 4c — the UNCONDITIONAL post-verify: prove a clean, current-head `review-code:` verdict is
# actually on the PR. Extracted from review-code/SKILL.md (#4451, epic #4435 phase 1). Extraction
# contract: ../SKILL.md § The extracted scripts.
#
# `verdict_post_verify` itself is SOURCED from its canonical home,
# ../../shared/scripts/verdict-readback.sh (#4489 extracted it out of
# ../../gh-issue-intake-formats.md) — there is no skill-local copy to drift. It re-derives the landed
# verdict from live PR state, never from a carried comment id: `$MINE` was set only on one posting
# branch, which is exactly how the #2264 recurrence slipped a broken/leaking marker through.
#
# PROPAGATE THE NON-ZERO. This wrapper's single FATAL exit is what makes verdict-posting an ENFORCED
# gate rather than a hopeful one — never report the gate done over an ungated PR.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

[ "$#" -ge 2 ] || { echo "usage: verdict-readback.sh <pr> <head-sha>" >&2; exit 2; }
PR="$1"; HEAD_SHA="$2"
# $REPO is what the sourced guard addresses `gh api` at, exactly as the fences did.
REPO="$(kp_repo)" || exit 1
export REPO
# shellcheck source=../../shared/scripts/verdict-readback.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/scripts" && pwd)/verdict-readback.sh"

# UNCONDITIONAL post-verify: resolve the landed verdict from PR state (marker comment @ HEAD_SHA, the
# advisory line, or the native APPROVE at commit_id==HEAD_SHA), then prove it present + well-formed +
# leak-free. FATAL (non-zero) on absent / malformed / leaking — the #2264 whole-body-path leak, a
# no-opped post, and a stale-head marker all fail here. Propagate the non-zero: never report the gate
# done over an ungated PR. Runs no matter which 4a/4b branch posted — no $MINE, no skippable path.
verdict_post_verify "$PR" review-code "$HEAD_SHA" || exit 1
