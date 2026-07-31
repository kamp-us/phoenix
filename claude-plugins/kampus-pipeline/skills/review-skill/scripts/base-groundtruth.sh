#!/usr/bin/env bash
# Step 2 — read a path off the FRESHLY FETCHED merge target, for an "is it shipped on main?"
# ground-truth check. Extracted from review-skill/SKILL.md (#4453, epic #4435 phase 1). Extraction
# contract + shell-option rationale: ../SKILL.md § The extracted scripts.
#
# It reads `origin/$BASE_REF` — never the working tree and never a local `main`, either of which may
# be stale in a long-lived checkout and would ground the check against an old merge target.
# `materialize-head.sh` already ran the fetch and recorded BASE_REF in the run handle; pass it in.
#
# Two modes, because the fence carried both: `exists` is the `git cat-file -e` presence probe (exit
# status IS the answer, no stdout), `show` prints the shipped content.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 3 ] || { echo "usage: base-groundtruth.sh <exists|show> <base-ref> <path>" >&2; exit 2; }
MODE="$1"; BASE_REF="$2"; TARGET="$3"

case "$MODE" in
  exists) git cat-file -e "origin/$BASE_REF:$TARGET" ;;   # does the path exist on fresh main?
  show)   git show "origin/$BASE_REF:$TARGET" ;;          # read shipped content
  *) echo "base-groundtruth.sh: mode must be 'exists' or 'show'." >&2; exit 2 ;;
esac
