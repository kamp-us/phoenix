#!/usr/bin/env bash
# Step 3 — the §HEAD #4 live-head re-check, then the guarded verdict upsert. Extracted from
# review-trivial/SKILL.md (#4453, epic #4435 phase 1). Extraction contract + shell-option rationale:
# ../SKILL.md § The extracted scripts.
#
# THE BODY ARRIVES ON STDIN — the declared seam. The fence told the reviewer to "write your composed
# verdict into $VERDICT_FILE", so the body is authored by the agent and a script can only receive it.
# Stdin also retires the scratch file entirely, which removes the #2683 class by construction: with
# no path on disk there is nothing to leak into the marker's `@ <sha>` field.
#
# THE NAMESPACE IS AN ARGUMENT, NOT A DEFAULT. The fence's `NS=code` was a placeholder the reviewer
# had to overwrite per Step 3's artifact-class routing; a default here would silently emit the wrong
# gate's marker on a doc or skill diff, which is the namespace collapse the skill forbids.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 2 ] || { echo "usage: printf '%s' \"\$BODY\" | verdict-post.sh <pr> <code|doc|skill> [reviewed-head-sha]" >&2; exit 2; }
PR="$1"; NS="$2"; HEAD_SHA="${3:-}"
case "$NS" in
  code|doc|skill) ;;
  *) echo "verdict-post.sh: '$NS' is not a gate namespace — refusing to guess (Step 3 routes by artifact class)." >&2; exit 2 ;;
esac
REPO="$(kp_repo)" || exit 1
# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="$(kp_pcli)" || exit 127

BODY="$(cat)"
[ -n "$BODY" ] || { echo "verdict-post.sh: EMPTY body on stdin — refusing to post an empty verdict; the PR would read as UNGATED." >&2; exit 1; }

if [ -n "$HEAD_SHA" ]; then
  HEAD_NOW="$(gh api repos/"$REPO"/pulls/"$PR" --jq .head.sha)" || {
    echo "verdict-post.sh: live head unreadable — cannot prove the head did not move; refusing to post (ADR 0058)." >&2; exit 1; }
  [ "$HEAD_NOW" = "$HEAD_SHA" ] || { echo "head moved under the verdict — re-review the new head or abort (ADR 0058)" >&2; exit 1; }
fi

# The first line of $BODY is the bare SHA-bound marker:
#   review-<NS>: PASS @ <HEAD_SHA> — merge-ready          (every check passed)
#   review-<NS>: FAIL @ <HEAD_SHA> — not merge-ready       (any check failed)
printf '%s' "$BODY" | "$PCLI" verdict post --pr "$PR" --gate "$NS"
