#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2016
# Reviewer-runnable proof that every extracted script is a BYTE-MOVE of the fenced block it replaced.
#
# For each (script, base-block-first-line) pair it slices the block out of `write-code/SKILL.md` at
# the BASE commit, applies only the metavariable→positional-parameter substitutions the script's own
# header declares, and diffs that against the script's moved region (from the same first line to EOF).
# A clean run prints `MATCH` per script and exits 0; any drift prints the diff and exits 1.
#
# Usage:  bash claude-plugins/kampus-pipeline/skills/write-code/scripts/verify-byte-move.sh [BASE_SHA]
# Default BASE_SHA is the commit this extraction branched from.
set -uo pipefail

BASE="${1:-cb52bd3efdbc2b2e3720793a96d90a6261e33536}"
ROOT="$(git rev-parse --show-toplevel)"
SKILL=claude-plugins/kampus-pipeline/skills/write-code/SKILL.md
DIR="$ROOT/claude-plugins/kampus-pipeline/skills/write-code/scripts"
TMP="$(mktemp -d)"
git show "$BASE:$SKILL" > "$TMP/base.md" || exit 1

# Slice the column-0 fenced block whose FIRST BODY LINE is $1, out of the base SKILL.md.
slice() {
  awk -v first="$1" '
    !inb && $0 == first && prev ~ /^```/ { inb=1 }
    inb && /^```[[:space:]]*$/ { exit }
    inb { print }
    { prev=$0 }
  ' "$TMP/base.md"
}

# Slice from the first occurrence of line $1 (anywhere) to the next closing fence, optionally
# stopping AFTER line $2. Used where only PART of a block moved, or where the block's own first line
# stayed behind in SKILL.md as a placeholder/template — both stated in the script's own header.
slice_part() {
  awk -v first="$1" -v last="$2" '
    !inb && $0 == first { inb=1 }
    inb && /^```[[:space:]]*$/ { exit }
    inb { print; if (last != "" && $0 == last) exit }
  ' "$TMP/base.md"
}

fail=0
MODE=whole
FROM=""
TO=""
check() {   # $1 = script name, $2 = first body line, $3.. = sed substitution exprs
  local script="$1" first="$2"; shift 2
  if [ "$MODE" = part ]; then slice_part "$FROM" "$TO" > "$TMP/base.block"; first="$FROM"; else slice "$first" > "$TMP/base.block"; fi
  MODE=whole; FROM=""; TO=""
  if [ ! -s "$TMP/base.block" ]; then echo "NO-BASE-BLOCK  $script"; fail=1; return; fi
  if [ "$#" -gt 0 ]; then sed "$@" "$TMP/base.block" > "$TMP/base.expected"; else cp "$TMP/base.block" "$TMP/base.expected"; fi
  awk -v first="$first" 'f{print} $0 == first && !f {f=1; print}' "$DIR/$script" > "$TMP/moved"
  if diff -u "$TMP/base.expected" "$TMP/moved" > "$TMP/d"; then
    echo "MATCH          $script ($(wc -l < "$TMP/base.expected" | tr -d ' ') lines)"
  else
    echo "DRIFT          $script"; cat "$TMP/d"; fail=1
  fi
}

check step1-candidate-pool.sh    "# p0 first; only fall through to p1, then p2 if a bucket is empty of unassigned issues"
check step1-parent-resolve.sh    "# \`-i\` keeps the status line on stdout even when gh exits non-zero, which is the whole point:" -e 's|<N>|$N|g'
check step3-delegated-claim.sh   "# §CLI — resolve the shim by path; \`pipeline-cli\` is NOT on PATH (ADR 0207; #3314)." -e 's|--issue <N>|--issue $N|g' -e 's|#<N>|#$N|g'
check step4-preflight.sh         "# fail closed unless we're in a LINKED git worktree (not the primary checkout)"
check step4d-blessed-surfaces.sh "# blessed surface-ids: the keys of the committed pointer's \`surfaces\` map (ADR 0183)."
check step5-acceptance-criteria.sh "# enumerate #N's acceptance criteria — the checklist you must satisfy in FULL to emit a closing keyword" -e 's|issues/<N>|issues/$N|g'
check step6-progress-comment.sh  "# §SP: the per-run scratch namespace — deterministic + fail-closed, never a shared fallback." -e 's|write-code-<N>|write-code-$N|' -e 's|"<N>"|"$N"|' -e 's|issues/<N>/comments|issues/$N/comments|'
check step7-epic-handoff.sh      "# compose under the per-run scratch namespace (§SP), never a fixed /tmp leaf — a concurrent" -e 's|write-code-<N>|write-code-$N|' -e 's|"<N>"|"$N"|' -e 's|issues/<EPIC>/comments|issues/$EPIC/comments|'
check stepR2-inline-comments.sh  "ME=\$(gh api user --jq '.login')   # don't action your own author-side replies"
check stepR-round-count.sh       "# how many distinct gate-FAIL ROUNDS has this PR already accrued (both namespaces)?"
check stepR-frozen-ac.sh         "# does this round's resolving FAIL table carry a review-appended AC tagged at/after the final round?"

# Partial moves — the base block's own first line stayed in SKILL.md as a placeholder or template.
MODE=part FROM="# the epic body carries the plan + the ## Dependencies topology" \
  check step2-epic-read.sh ""
MODE=part FROM="# 0. Fail-closed on a missing token: the claim comment is the ONLY agent-distinguishable signal" \
  check step3-direct-claim.sh "" -e 's|tracker claim <N>|tracker claim $N|' -e 's|--issue <N>|--issue $N|' -e 's|#<N>|#$N|g'
check step3_5-my-claim.sh        "# the claim token this run owns work under: the orchestrator's threaded delegated token if it"
MODE=part FROM="# Fetch the base fresh, and FAIL-LOUD if it doesn't run: FETCH_HEAD is what the branch below is" \
  check step4-branch.sh "" -e 's|<slug-for-issue-N>-\$(uuidgen|$SLUG-$(uuidgen|'
MODE=part FROM="# the child's containment marker; a missing line reads as \`none\` (formats §2 tolerant-read rule)" \
  check step4b-containment.sh "" -e 's|issues/<N>|issues/$N|'
MODE=part FROM="N=\$(gh api repos/\$REPO/pulls/\$PR \\" \
  check stepR2-linked-issue.sh ""
MODE=part FROM="# re-assert the mis-attribution guard (Step 3.5) before the resubmit push — a between-calls cwd" \
  check stepR3-push-and-note.sh ""
# Halves of the Step-5 block: the mechanical prelude moved, the `gh pr create` heredoc did not.
MODE=part FROM="# RE-DERIVE the branch LIVE from the worktree — never a cached/shared-file value (see the" \
  TO="claim_is_mine \"<N>\" || { echo \"refusing to open a PR against #<N> — not my claim (Step 3.5)\"; exit 1; }" \
  check step5-push.sh "" -e 's|"<N>"|"$N"|' -e 's|#<N>|#$N|g'

MODE=part FROM="# claim_is_mine <N>: resolve the EARLIEST AUTHORIZED claim marker on #N (issue or PR) and assert" TO="}" \
  check step3_5-claim-is-mine.sh ""
MODE=part FROM="# the last mutation of the run — retract OUR OWN claim marker on the issue we just built." \
  check step8-claim-release.sh "" -e 's|"<N>"|"$N"|'

# NOT mechanically checked here, and why — each is stated in the script's own header:
#   step5-seam-checks.sh    the two `<N>` sites inside single-quoted EREs are spliced by
#                           quote-concatenation ('…#'"$N"'\b'), so the line differs from base while
#                           the PATTERN bytes do not — a textual diff cannot express that.
#   stepR2-fail-body.sh     the block hardcoded $CODE_FAIL_JSON with a prose "swap per namespace"
#                           instruction; the script indirects through a named variable instead.
#   stepR3-thread-reply.sh  the reply body was a per-run template, so it arrives as $1.

rm -rf "$TMP"
[ "$fail" -eq 0 ] || { echo "FAIL: at least one script drifted from its base block."; exit 1; }
echo "OK: every checked script is a byte-move of its base block (modulo the declared metavariable seams)."
