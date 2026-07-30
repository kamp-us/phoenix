#!/usr/bin/env bash
# Print the PR's CURRENT head SHA, and warn on stderr when it has moved off the head under review.
# The gate is stateless: a head that advanced mid-review means the preview you captured is stale, so
# the caller re-captures against the printed head before posting (never bind a verdict to a head
# whose UI you didn't see).
#
# usage: current-head.sh <pr> <head-sha-under-review>
#
# The caller re-assigns HEAD_SHA from stdout — a separate process cannot assign the caller's
# variable, so the block's in-place `HEAD_SHA="$HEAD_NOW"` becomes the printed value. The warning
# goes to stderr so stdout stays the bare SHA.
#
# Extracted from review-design/SKILL.md (#4453, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

[ "$#" -ge 2 ] || { echo "usage: current-head.sh <pr> <head-sha-under-review>" >&2; exit 2; }
PR="$1"; HEAD_SHA="$2"
REPO="$(kp_repo)" || exit 1

HEAD_NOW="$(gh api "repos/$REPO/pulls/$PR" --jq .head.sha)"
[ "$HEAD_NOW" = "$HEAD_SHA" ] || echo "head moved ($HEAD_SHA → $HEAD_NOW) during review — re-capture against $HEAD_NOW before posting" >&2
printf '%s\n' "$HEAD_NOW"
