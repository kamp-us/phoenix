#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC2016
# Reviewer-runnable proof of the two properties a conversion can still get wrong.
#
# 1. §ZS — no caller can read a script's FAILURE as a permissive answer (ADR 0092; #4231/#4010/#4219).
#    Every script that takes a required seam is EXECUTED with NO argument, and BOTH observables are
#    captured: the EXIT CODE and the STDOUT BYTE COUNT. The required shape is `rc != 0 && bytes == 0`
#    — the script produced no answer at all, so there is nothing for a caller to mistake for one. A
#    printed message is not proof, which is why the byte count is measured rather than eyeballed.
#
#    `bash <script>` replaces the old `( . <script> )` because ADR 0232 made execution the sanctioned
#    invocation: a proof that exercised the retired form would vouch for a shape nothing runs.
#
# 2. ZERO COVERAGE DELTA for the two guards that follow this shell out of SKILL.md into `scripts/`.
#    Both reach a `.sh` at this head: `cli-invocation-guard` scans a shell file as one implicit
#    whole-file fence (#4486 is CLOSED, fixed by #4494), and `leak-guard` scans `.sh` as a second
#    surface (#4507 landed SHELL_SUFFIXES). So the CI-enforced coverage of these scripts is real,
#    not vacuous, and neither grep below is the only thing standing over them — each is an
#    independent, deliberately-broader restatement of a guard's matcher, run at authoring time
#    instead of merge time. This harness is itself DOC_SELF_EXEMPT in leak-guard — see section 2.
#
# Usage:  bash claude-plugins/kampus-pipeline/skills/write-code/scripts/verify-fail-closed.sh
set -uo pipefail

DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
TMP="$(mktemp -d)"
if [ -z "$TMP" ] || [ ! -d "$TMP" ]; then
  echo "FAIL: mktemp -d produced no temp root — refusing to run against nothing (ADR 0092)"
  exit 1
fi
fail=0

echo "=== 1. §ZS: every seam refuses with a NON-ZERO exit and ZERO stdout bytes"
# Every script that takes a REQUIRED positional seam. `stepR2-fail-body.sh` is in scope even though
# its namespace argument is defaulted: the property under test is that a no-argument RUN produces no
# answer, and it holds there too (its PR seam is required), so excluding it would leave the harness
# claiming less than its own scope (#4503 review).
SEAMED="step1-milestone-pool.sh step1-parent-resolve.sh step2-epic-read.sh step3-delegated-claim.sh
        step3-direct-claim.sh step3_5-claim-is-mine.sh step4-branch.sh step4-live-branch.sh
        step4b-containment.sh step5-acceptance-criteria.sh
        step5-push.sh step5-seam-checks.sh step6-progress-comment.sh step7-epic-handoff.sh
        step8-claim-release.sh stepR1-verdicts.sh stepR-frozen-ac.sh stepR-round-count.sh
        stepR2-branch-rebase.sh stepR2-fail-body.sh stepR2-inline-comments.sh stepR2-linked-issue.sh
        stepR3-push-and-note.sh stepR3-thread-reply.sh type-investigation-close.sh"
for s in $SEAMED; do
  bash "$DIR/$s" > "$TMP/out" 2> "$TMP/err"
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

echo "=== 2. zero-coverage-delta greps over the converted scripts"
# Scope: the converted scripts. The `verify-*.sh` proof harnesses are excluded, because they must
# spell the forbidden tokens out as patterns to test for them — which is also why this file carries a
# DOC_SELF_EXEMPT entry now that leak-guard reaches `.sh`, mirroring path-matcher.ts. Paths are
# printed repo-relative on purpose: a machine-local absolute path must not reach a PR body either.
cd "$(git rev-parse --show-toplevel)" || exit 1
REL=claude-plugins/kampus-pipeline/skills/write-code/scripts
MOVED=$(git ls-files "$REL/*.sh" | grep -v "/verify-")
if [ -z "$MOVED" ]; then
  echo "FAIL: zero scope — no converted script resolved under $REL (ADR 0092)"
  rm -rf "$TMP"; exit 1
fi
echo "      scope: $(printf '%s\n' "$MOVED" | wc -l | tr -d ' ') converted script(s) under $REL"
# A bare `pipeline-cli` INVOCATION is what cli-invocation-guard forbids: the token not preceded by a
# path/word character, on a line that is not a comment. Its own matcher skips comment-only lines, so
# the backtick-quoted `pipeline-cli` mentions inside the comments are out of scope for both.
# shellcheck disable=SC2086
hits=$(grep -nE '(^|[^[:alnum:]./@_-])pipeline-cli([[:space:]]|$)' $MOVED | grep -vE ':[[:space:]]*#' || true)
if [ -z "$hits" ]; then
  echo "OK    zero bare \`pipeline-cli\` invocations outside a comment (every CLI reach reads \"\$PCLI\", resolved by path)"
else
  echo "BAD   bare invocation(s):"; printf '%s\n' "$hits"; fail=1
fi
# EVERY arm of leak-guard's shared path matcher, not one of them. Grepping only the `/Users/` arm
# proved the delta zero for a sixth of the guard it clears, leaving the other five to be re-derived by
# hand at review time (#4503 review). ERE has no lookbehind, so each arm below is the guard's shape
# with its narrowing lookarounds DROPPED — deliberately broader than the guard, since a proof of zero
# hits under a broader pattern implies zero under the narrower one. Source of truth for the shapes:
# packages/pipeline-cli/src/tools/leak-guard/path-matcher.ts.
ARMS='absolute home path (/Users/<name>, /home/<name>)::/(Users|home)/[A-Za-z0-9._-]+
agent/tool home dir (~/.usirin, ~/.agent)::~/\.(usirin|agent)
agent/tool home dir (~/.claude internals)::~/\.claude
home-dir sibling-repo clone (~/code/...)::~/code/
home-dir sibling-repo clone (~/<root>/<host>/<user>/<repo>)::~/[A-Za-z0-9._-]+/[A-Za-z0-9-]+\.[A-Za-z][A-Za-z]+/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+
vault path (/vault/...)::/vault/
comment-surface temp root (/var/folders/...)::/var/folders/[A-Za-z0-9._/-]+
comment-surface temp root (/private/tmp, /private/var)::/private/(tmp|var)/[A-Za-z0-9._/-]+
comment-surface temp root (bare /tmp)::/tmp/[A-Za-z0-9._/-]+'
while IFS= read -r arm; do
  reason="${arm%%::*}"; pattern="${arm#*::}"
  # shellcheck disable=SC2086
  hits=$(grep -nE "$pattern" $MOVED || true)
  if [ -z "$hits" ]; then
    printf 'OK    zero hits — %s\n' "$reason"
  else
    printf 'BAD   %s:\n' "$reason"; printf '%s\n' "$hits"; fail=1
  fi
done <<EOF
$ARMS
EOF

rm -rf "$TMP"
[ "$fail" -eq 0 ] || { echo "FAIL"; exit 1; }
echo "OK: both properties hold."
