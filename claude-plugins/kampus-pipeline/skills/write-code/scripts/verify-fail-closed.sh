#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1090,SC2016
# Reviewer-runnable proof of the two properties a byte-move can still get wrong.
#
# 1. §ZS — no caller can read a script's FAILURE as a permissive answer (ADR 0092; #4231/#4010/#4219).
#    Every script that takes a metavariable seam is sourced with NO argument, and BOTH observables are
#    captured: the EXIT CODE and the STDOUT BYTE COUNT. The required shape is `rc != 0 && bytes == 0`
#    — the script produced no answer at all, so there is nothing for a caller to mistake for one. A
#    printed message is not proof, which is why the byte count is measured rather than eyeballed.
#
# 2. ZERO COVERAGE DELTA for the two guards this extraction NARROWS. `cli-invocation-guard` is
#    fence-scoped to markdown (#4486) and `leak-guard`'s DOC_SUFFIXES is markdown-only (#4496), so
#    neither inspects a `.sh`. Their clean runs are therefore VACUOUS over these files — the delta is
#    zero only if the files carry nothing either guard would have flagged. That is what is grepped:
#    zero bare `pipeline-cli` invocations outside a comment, and zero `/Users/<name>` or `/home/<name>`
#    paths, anywhere in the new scripts.
#
# Usage:  bash claude-plugins/kampus-pipeline/skills/write-code/scripts/verify-fail-closed.sh
set -uo pipefail

DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
TMP="$(mktemp -d)"
fail=0

echo "=== 1. §ZS: every seam refuses with a NON-ZERO exit and ZERO stdout bytes"
SEAMED="step1-parent-resolve.sh step2-epic-read.sh step3-delegated-claim.sh step3-direct-claim.sh
        step4-branch.sh step4b-containment.sh step5-acceptance-criteria.sh step5-push.sh
        step5-seam-checks.sh step6-progress-comment.sh step7-epic-handoff.sh step8-claim-release.sh
        stepR2-branch-rebase.sh stepR3-thread-reply.sh"
for s in $SEAMED; do
  ( . "$DIR/$s" ) > "$TMP/out" 2> "$TMP/err"
  rc=$?
  bytes=$(wc -c < "$TMP/out" | tr -d ' ')
  if [ "$rc" -ne 0 ] && [ "$bytes" -eq 0 ]; then
    printf 'OK    %-34s rc=%-3s stdout-bytes=%s (stderr-bytes=%s)\n' "$s" "$rc" "$bytes" \
      "$(wc -c < "$TMP/err" | tr -d ' ')"
  else
    printf 'BAD   %-34s rc=%-3s stdout-bytes=%s — a caller could read this as an ANSWER\n' "$s" "$rc" "$bytes"
    fail=1
  fi
done

echo "=== 2. zero-coverage-delta greps over the extracted scripts"
# Scope: the EXTRACTED scripts. The two `verify-*.sh` proof harnesses are excluded, because they must
# spell the forbidden tokens out as patterns to test for them — the same self-exemption leak-guard's
# own DOC_SELF_EXEMPT applies to its own source. Paths are printed repo-relative on purpose: a
# machine-local absolute path must not reach a PR body either.
cd "$(git rev-parse --show-toplevel)" || exit 1
REL=claude-plugins/kampus-pipeline/skills/write-code/scripts
MOVED=$(git ls-files "$REL/*.sh" | grep -v "/verify-")
echo "      scope: $(printf '%s\n' "$MOVED" | wc -l | tr -d ' ') extracted script(s) under $REL"
# A bare `pipeline-cli` INVOCATION is what cli-invocation-guard forbids: the token not preceded by a
# path/word character, on a line that is not a comment. Its own matcher skips comment-only lines, so
# the backtick-quoted `pipeline-cli` mentions inside the moved comments are out of scope for both.
# shellcheck disable=SC2086
hits=$(grep -nE '(^|[^[:alnum:]./@_-])pipeline-cli([[:space:]]|$)' $MOVED | grep -vE ':[[:space:]]*#' || true)
if [ -z "$hits" ]; then
  echo "OK    zero bare \`pipeline-cli\` invocations outside a comment (every CLI reach reads \"\$PCLI\", resolved by path)"
else
  echo "BAD   bare invocation(s):"; printf '%s\n' "$hits"; fail=1
fi
# shellcheck disable=SC2086
hits=$(grep -nE '/(Users|home)/[A-Za-z0-9._-]+' $MOVED || true)
if [ -z "$hits" ]; then
  echo "OK    zero /Users/<name> or /home/<name> paths (nothing leak-guard would have flagged)"
else
  echo "BAD   machine-local path(s):"; printf '%s\n' "$hits"; fail=1
fi

rm -rf "$TMP"
[ "$fail" -eq 0 ] || { echo "FAIL"; exit 1; }
echo "OK: both properties hold."
