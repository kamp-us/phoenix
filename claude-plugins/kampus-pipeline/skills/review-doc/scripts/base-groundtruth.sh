#!/usr/bin/env bash
# Step 2 — refresh the merge target, then read a path off it for an "is it shipped on main?"
# ground-truth check. Extracted from review-doc/SKILL.md (#4453, epic #4435 phase 1). Extraction
# contract + shell-option rationale: ../SKILL.md § The extracted scripts.
#
# The fetch is the point: a stale local `main` is what false-FAILed PR #305, whose consumers had
# merged minutes earlier. Freshness is structural here — a fetch this script runs, not a property of
# whoever's checkout the gate happens to run in. It never reads the working tree.
#
# Three modes, because the fence carried three steps: `fetch` refreshes the base and prints the ref
# it refreshed; `exists` is the `git cat-file -e` presence probe (exit status IS the answer, no
# stdout); `show` prints the shipped content.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 2 ] || { echo "usage: base-groundtruth.sh fetch <pr> | base-groundtruth.sh <exists|show> <base-ref> <path>" >&2; exit 2; }
MODE="$1"

if [ "$MODE" = "fetch" ]; then
  PR="$2"
  REPO="$(kp_repo)" || exit 1
  BASE_REF="$(gh api repos/"$REPO"/pulls/"$PR" --jq '.base.ref')"   # normally main
  [ -n "$BASE_REF" ] || { echo "base-groundtruth.sh: could not resolve the PR's base ref — no ground truth to check against." >&2; exit 1; }
  git fetch origin "$BASE_REF" >&2                                  # refresh the merge target
  printf '%s\n' "$BASE_REF"
  exit 0
fi

[ "$#" -ge 3 ] || { echo "usage: base-groundtruth.sh <exists|show> <base-ref> <path>" >&2; exit 2; }
BASE_REF="$2"; TARGET="$3"
# Verify shipped-state against the FETCHED remote ref, not the working tree / local main:
case "$MODE" in
  exists) git cat-file -e "origin/$BASE_REF:$TARGET" ;;   # does this path exist on fresh main?
  show)   git show "origin/$BASE_REF:$TARGET" ;;          # read its shipped content to confirm
  *) echo "base-groundtruth.sh: mode must be 'fetch', 'exists' or 'show'." >&2; exit 2 ;;
esac
