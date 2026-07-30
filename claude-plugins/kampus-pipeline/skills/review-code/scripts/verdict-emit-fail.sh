#!/usr/bin/env bash
# Step 4b — upsert the FAIL verdict through the guarded tool. Extracted from review-code/SKILL.md
# (#4451, epic #4435 phase 1). Extraction contract: ../SKILL.md § The extracted scripts.
#
# THE BODY ARRIVES ON STDIN — the same declared seam as the PASS emitter, for the same reason: the
# fence's heredoc carried a `… your per-criterion evidence table …` placeholder the reviewer authors,
# and piping on stdin means no fixed or `${PR}`-keyed scratch name a concurrent run can clobber
# (#1465/#3718/#3801).
#
# No native REQUEST_CHANGES here: the fence made that an optional nicety on top, and the comment with
# per-criterion evidence is the REQUIRED artifact.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

[ "$#" -ge 2 ] || { echo "usage: printf '%s' \"\$BODY\" | verdict-emit-fail.sh <pr> <head-sha>" >&2; exit 2; }
PR="$1"; HEAD_SHA="$2"
PCLI="$(kp_pcli)" || exit 127
# resolve the verdict CLI via the `bin/pipeline-cli` shim — in-repo bin, else the installed bin,
# else the pinned `pnpm dlx` fallback reading the one pin (hooks/pin.sh); no version pinned here
# (#3653; ADR 0062/0064; epic #994)
VERDICT=("$PCLI" verdict)

BODY="$(cat)"
[ -n "$BODY" ] || { echo "verdict-emit-fail.sh: EMPTY body on stdin — refusing to post an empty verdict; the PR would read as UNGATED." >&2; exit 1; }

# Upsert through the guarded tool (resolved above), exactly as the PASS path: it upserts the one
# review-code marker (namespace-anchored, advisory included) and fail-closes on a malformed/
# cross-namespace body (so the mktemp-path `@ <sha>` leak #2683 can't land) AND on a body bound to
# another PR's head (the #3801 post-time cross-check).
printf '%s' "$BODY" | "${VERDICT[@]}" post --pr "$PR" --gate code
echo "verdict-emit-fail: review-code FAIL emitted for PR #$PR @ ${HEAD_SHA:0:7} — now run verdict-readback.sh." >&2
