#!/usr/bin/env bash
# Step 4a — emit the PASS verdict through the guarded path: `verdict validate` as a read-back
# assertion, then the native approving review, falling back to the `verdict post` comment upsert.
# Extracted from review-code/SKILL.md (#4451, epic #4435 phase 1). Extraction contract:
# ../SKILL.md § The extracted scripts.
#
# THE BODY ARRIVES ON STDIN — the declared seam. The fence composed it into `$BODY` with a heredoc
# whose table was a `… your per-criterion evidence table …` placeholder; the reviewer authors that
# body, so a script can only receive it. Composing on stdin also keeps the #1465/#3718/#3801
# collision surface gone by construction: with no file on disk there is nothing for a concurrent
# review of the same PR to clobber, and no scratch path that could bleed into the `@ <sha>` field.
#
# The APPROVE→fallback chain is an EXPLICIT `if`, never `APPROVE || post`: a shell pipe wrapping the
# APPROVE call makes the pipeline's status mask the APPROVE failure, so the `||` fallback silently
# never fires and no verdict lands.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

[ "$#" -ge 2 ] || { echo "usage: printf '%s' \"\$BODY\" | verdict-emit-pass.sh <pr> <head-sha>" >&2; exit 2; }
PR="$1"; HEAD_SHA="$2"
REPO="$(kp_repo)" || exit 1
PCLI="$(kp_pcli)" || exit 127
# resolve the verdict CLI via the `bin/pipeline-cli` shim — in-repo bin, else the installed bin,
# else the pinned `pnpm dlx` fallback reading the one pin (hooks/pin.sh); no version pinned here
# (#3653; ADR 0062/0064; epic #994)
VERDICT=("$PCLI" verdict)

BODY="$(cat)"
[ -n "$BODY" ] || { echo "verdict-emit-pass.sh: EMPTY body on stdin — refusing to post an empty verdict; the PR would read as UNGATED." >&2; exit 1; }

# Read-back assertion BEFORE the native APPROVE: the same gate `verdict post` enforces, piped on
# stdin, so a malformed `@ <sha>` (e.g. an mktemp scratch path, #2683) fails loud here, never in a
# review body.
printf '%s' "$BODY" | "${VERDICT[@]}" validate --gate code || {
  echo "FATAL: composed review-code marker is malformed — refusing to post (fix the @ <sha> field; #2683)" >&2
  exit 1
}
if gh api -X POST repos/"$REPO"/pulls/"$PR"/reviews \
     -f event=APPROVE -f body="$BODY"; then
  : # native approving review posted (GitHub records its commit_id = the head you approved;
    #  ship-it reads that commit_id for the same staleness test the marker's @ <sha> drives)
else
  # APPROVE failed (e.g. 422 on your own PR) — upsert the structured pass comment instead, through
  # the guarded tool on stdin: it PATCHes your newest own review-code marker (namespace-anchored, so
  # it also upserts a prior advisory across a non-blocking↔blocking flip) else POSTs the first, and
  # it fail-closes on a malformed/cross-namespace body AND on a body bound to another PR's head
  # (the #3801 post-time cross-check) so a broken/mis-bound marker never reaches GitHub.
  printf '%s' "$BODY" | "${VERDICT[@]}" post --pr "$PR" --gate code
fi
# $HEAD_SHA is the caller's single-sourced read (current-head.sh); echo it so the run log ties the
# emitted verdict to the head Step 4c must then find landed.
echo "verdict-emit-pass: review-code PASS emitted for PR #$PR @ ${HEAD_SHA:0:7} — now run verdict-readback.sh, which is what makes posting an ENFORCED gate." >&2
