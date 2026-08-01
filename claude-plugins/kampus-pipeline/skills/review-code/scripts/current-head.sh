#!/usr/bin/env bash
# Step 4a/4b — the head SHA you actually reviewed, resolved ONCE before composing the verdict, so the
# SHA the marker carries and every later use are one single-sourced read rather than two independent
# resolutions that could straddle a head move. Extracted from review-code/SKILL.md (#4451, epic
# #4435 phase 1). Extraction contract: ../SKILL.md § The extracted scripts.
#
# Prints a bare 40-hex SHA or NOTHING. Shape-asserted, because gh writes its error document to
# STDOUT on failure: an unshape-checked capture would put that document into the marker's `@ <sha>`
# field, and `verdict post`'s emissionDefect gate would then refuse the whole verdict (#2683).
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

# usage-miss-sentinel: <silent>
[ "$#" -ge 1 ] || { echo "usage: current-head.sh <pr>" >&2; exit 2; }
PR="$1"
REPO="$(kp_repo)" || exit 1

HEAD_SHA="$(gh api repos/"$REPO"/pulls/"$PR" --jq .head.sha)" || {
  echo "current-head.sh: head SHA read FAILED (payload discarded) — no SHA to bind a verdict to." >&2; exit 1; }
case "$HEAD_SHA" in
  *[!0-9a-f]*|"") echo "current-head.sh: head SHA is not bare hex — discarded (never let gh's error body reach the marker's @ <sha>; #2683)." >&2; exit 1 ;;
esac
[ "${#HEAD_SHA}" -eq 40 ] || { echo "current-head.sh: head SHA is not a 40-char ref — discarded." >&2; exit 1; }
printf '%s\n' "$HEAD_SHA"
