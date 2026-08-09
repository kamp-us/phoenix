#!/usr/bin/env bash
# Re-derives, rather than asserts, that all THREE `teardown-head.sh` copies fail closed the same way
# (#5193 + #4972). Reviewer-runnable, self-contained, and it touches neither the primary checkout's
# worktrees nor its refs: the one case that actually tears something down runs inside a throwaway git
# repo under $TMPDIR.
#
# Six cases per gate:
#   A  namespace never opened            -> exit 0, quiet no-op (idempotence preserved)
#   B  namespace open, no handle file    -> exit 0, quiet no-op (nothing was materialized)
#   C  resolver could not run            -> NON-ZERO (the #4972 / #5193 fail-open, now closed)
#   D  handle readable but malformed     -> NON-ZERO while still refusing to guess a path
#   E  handle well-formed                -> exit 0 AND the tree + ref are actually gone
#   F  source shape                      -> invoked via `bash`, stderr not discarded (#5193's 126)
#
# Case E doubles as #5193's live proof for two of the three gates: `review-skill`'s and `review-doc`'s
# `head-env.sh` are committed 100644, so E only passes because the sibling is now run through `bash`.
#
# usage: bash teardown-head-fail-closed-proof.sh          # prints one PASS/FAIL row per case
# SC2016: case F greps for the LITERAL `bash "$HERE/head-env.sh"` source line, so it must not expand.
# shellcheck disable=SC1091,SC1007,SC2016
set -uo pipefail
HERE="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN="$(CDPATH= cd -- "$HERE/../../.." && pwd)"
# shellcheck source=../../../lib/common.sh
. "$PLUGIN/lib/common.sh"
PCLI="$(kp_pcli)" || exit 127

FAILED=0
ok() { printf 'PASS  %s\n' "$1"; }
bad() {
  printf 'FAIL  %s\n' "$1"
  FAILED=1
}
# expect <actual-rc> <zero|nonzero> <label>
expect() {
  if [ "$2" = zero ]; then
    if [ "$1" -eq 0 ]; then ok "$3 (rc=$1)"; else bad "$3 — expected 0, got $1"; fi
  else
    if [ "$1" -ne 0 ]; then ok "$3 (rc=$1)"; else bad "$3 — expected non-zero, got 0"; fi
  fi
}

PR=99999
# `<gate> <slug> <leaf> <takes-pr>` — the three copies diverge only in these four fields.
GATES="review-code review-code-head head.env no
review-skill review-skill-head-$PR wt.env yes
review-doc review-doc-$PR head.env yes"

# Run one gate's teardown under a fresh session id; echoes its exit status.
run_teardown() { # <gate> <takes-pr> <session>
  local gate="$1" takes_pr="$2" session="$3" script
  script="$PLUGIN/skills/$gate/scripts/teardown-head.sh"
  if [ "$takes_pr" = yes ]; then
    CLAUDE_CODE_SESSION_ID="$session" bash "$script" "$PR" >/dev/null 2>&1
  else
    CLAUDE_CODE_SESSION_ID="$session" bash "$script" >/dev/null 2>&1
  fi
  echo $?
}

while read -r GATE SLUG LEAF TAKES_PR; do
  [ -n "$GATE" ] || continue
  TD="$PLUGIN/skills/$GATE/scripts/teardown-head.sh"

  # A — a namespace this session never opened is the genuine no-op the header promises.
  RC="$(run_teardown "$GATE" "$TAKES_PR" "proof-a-$GATE-$$")"
  expect "$RC" zero "$GATE A never-opened namespace -> exit 0"

  # B — namespace open but no handle file: still nothing was materialized.
  SESSION="proof-b-$GATE-$$"
  CLAUDE_CODE_SESSION_ID="$SESSION" "$PCLI" scratchpad open --slug "$SLUG" >/dev/null 2>&1
  RC="$(run_teardown "$GATE" "$TAKES_PR" "$SESSION")"
  expect "$RC" zero "$GATE B open-but-no-handle -> exit 0"

  # C — the resolver could not look. No session id is the cheapest real instance of that class
  # (scratchpad exits 2, MissingSessionId); pre-fix EVERY such code reported as a clean no-op.
  if [ "$TAKES_PR" = yes ]; then
    (unset CLAUDE_CODE_SESSION_ID; bash "$TD" "$PR" >/dev/null 2>&1)
  else
    (unset CLAUDE_CODE_SESSION_ID; bash "$TD" >/dev/null 2>&1)
  fi
  RC=$?
  expect "$RC" nonzero "$GATE C unreadable handle -> non-zero"

  # D — a handle that exists but names nothing: positive evidence something WAS materialized.
  SESSION="proof-d-$GATE-$$"
  DIR="$(CLAUDE_CODE_SESSION_ID="$SESSION" "$PCLI" scratchpad open --slug "$SLUG" 2>/dev/null)"
  printf '# malformed on purpose: no REVIEW_WT, no PR_REF\n' >"$DIR/$LEAF"
  RC="$(run_teardown "$GATE" "$TAKES_PR" "$SESSION")"
  expect "$RC" nonzero "$GATE D malformed handle -> non-zero"

  # E — the happy path, inside a throwaway repo so the primary's worktrees and refs are untouched.
  SESSION="proof-e-$GATE-$$"
  DIR="$(CLAUDE_CODE_SESSION_ID="$SESSION" "$PCLI" scratchpad open --slug "$SLUG" 2>/dev/null)"
  SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/teardown-proof.XXXXXX")"
  git -C "$SANDBOX" init -q
  git -C "$SANDBOX" -c user.email=proof@invalid -c user.name=proof commit -q --allow-empty -m proof
  REF="refs/pr/proof-$GATE-$$"
  git -C "$SANDBOX" update-ref "$REF" HEAD
  TREE="$SANDBOX/throwaway-head"
  mkdir -p "$TREE"
  printf 'REVIEW_WT=%s\nPR_REF=%s\n' "$TREE" "$REF" >"$DIR/$LEAF"
  if [ "$TAKES_PR" = yes ]; then
    (cd "$SANDBOX" && CLAUDE_CODE_SESSION_ID="$SESSION" bash "$TD" "$PR" >/dev/null 2>&1)
  else
    (cd "$SANDBOX" && CLAUDE_CODE_SESSION_ID="$SESSION" bash "$TD" >/dev/null 2>&1)
  fi
  RC=$?
  if [ "$RC" -eq 0 ] && [ ! -d "$TREE" ] && ! git -C "$SANDBOX" show-ref --quiet --verify "$REF"; then
    ok "$GATE E well-formed handle -> tree + ref removed, exit 0"
  else
    bad "$GATE E expected a real teardown (rc=$RC, tree-present=$([ -d "$TREE" ] && echo yes || echo no))"
  fi
  rm -rf "$SANDBOX"

  # F — the #5193 shape itself: the sibling is run through `bash` (so its committed 100644 mode is
  # irrelevant) and its stderr survives (so the cause is nameable). Static, because a 126 is exactly
  # what case C would otherwise have to reproduce by chmod'ing a committed file.
  if grep -q 'bash "\$HERE/head-env.sh"' "$TD" && ! grep -q 'head-env.sh.*2>/dev/null' "$TD"; then
    ok "$GATE F sibling invoked via bash, stderr surfaced"
  else
    bad "$GATE F direct exec or discarded stderr is back in $GATE/scripts/teardown-head.sh"
  fi
done <<EOF
$GATES
EOF

if [ "$FAILED" -ne 0 ]; then
  echo "teardown-head fail-closed proof: FAILED" >&2
  exit 1
fi
echo "teardown-head fail-closed proof: all cases passed for all three gates"
