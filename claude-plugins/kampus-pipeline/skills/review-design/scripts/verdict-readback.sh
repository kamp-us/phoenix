#!/usr/bin/env bash
# Run the shared contract's read-back guard over the just-upserted `review-design` verdict comment
# (#2148): re-read it and assert the canonical marker, the anchored `Reviewed-head: @ <sha>` line,
# and no leaked local filesystem path. Non-zero = the verdict did NOT land clean.
#
# usage: verdict-readback.sh <comment-id> <head-sha>
#
# Extracted from review-design/SKILL.md (#4453, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"
# `verdict_readback_guard` itself, sourced from its canonical home — no skill-local copy to drift
# (#4489 extracted it out of `../../gh-issue-intake-formats.md`).
# shellcheck source=../../shared/scripts/verdict-readback.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/scripts" && pwd)/verdict-readback.sh"

[ "$#" -ge 2 ] || { echo "usage: verdict-readback.sh <comment-id> <head-sha>" >&2; exit 2; }
CID="$1"; HEAD_SHA="$2"
# shellcheck disable=SC2034  # read by verdict_readback_guard, which takes $REPO from the environment
REPO="$(kp_repo)" || exit 1

verdict_readback_guard "$CID" review-design "$HEAD_SHA"
