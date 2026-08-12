#!/usr/bin/env bash
# Re-derives, rather than asserts, that all THREE `teardown-head.sh` copies fail closed the same way
# (#5193 + #4972). Reviewer-runnable, self-contained, and it touches neither the primary checkout's
# worktrees nor its refs: the one case that actually tears something down runs inside a throwaway git
# repo under $TMPDIR.
#
# Six cases per gate, plus a seventh that only `review-code` carries:
#   A  namespace never opened            -> exit 0, quiet no-op (idempotence preserved)
#   B  namespace open, no handle file    -> exit 0, quiet no-op (nothing was materialized)
#   C  resolver could not run            -> NON-ZERO (the #4972 / #5193 fail-open, now closed)
#   D  handle readable but malformed     -> NON-ZERO while still refusing to guess a path
#   E  handle well-formed                -> exit 0 AND the tree + ref are actually gone
#   F  source shape                      -> invoked via `bash`, stderr not discarded (#5193's 126)
#   G  handle describes ANOTHER PR       -> NON-ZERO, and the sibling's tree survives (#5416)
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
# `<gate> <slug> <leaf>` — the three copies diverge only in these three fields. All three now take
# the PR: `review-code`'s slug was the last session-only one, and a session-only key let a fanned
# drain's gates share one handle and tear down each other's trees (#5416).
GATES="review-code review-code-head-$PR head.env
review-skill review-skill-head-$PR wt.env
review-doc review-doc-$PR head.env"

# Run one gate's teardown under a fresh session id; echoes its exit status.
run_teardown() { # <gate> <session>
  local gate="$1" session="$2" script
  script="$PLUGIN/skills/$gate/scripts/teardown-head.sh"
  CLAUDE_CODE_SESSION_ID="$session" bash "$script" "$PR" >/dev/null 2>&1
  echo $?
}

while read -r GATE SLUG LEAF; do
  [ -n "$GATE" ] || continue
  TD="$PLUGIN/skills/$GATE/scripts/teardown-head.sh"

  # A — a namespace this session never opened is the genuine no-op the header promises.
  RC="$(run_teardown "$GATE" "proof-a-$GATE-$$")"
  expect "$RC" zero "$GATE A never-opened namespace -> exit 0"

  # B — namespace open but no handle file: still nothing was materialized.
  SESSION="proof-b-$GATE-$$"
  CLAUDE_CODE_SESSION_ID="$SESSION" "$PCLI" scratchpad open --slug "$SLUG" >/dev/null 2>&1
  RC="$(run_teardown "$GATE" "$SESSION")"
  expect "$RC" zero "$GATE B open-but-no-handle -> exit 0"

  # C — the resolver could not look. No session id is the cheapest real instance of that class
  # (scratchpad exits 2, MissingSessionId); pre-fix EVERY such code reported as a clean no-op.
  (unset CLAUDE_CODE_SESSION_ID; bash "$TD" "$PR" >/dev/null 2>&1)
  RC=$?
  expect "$RC" nonzero "$GATE C unreadable handle -> non-zero"

  # D — a handle that exists but names nothing: positive evidence something WAS materialized.
  SESSION="proof-d-$GATE-$$"
  DIR="$(CLAUDE_CODE_SESSION_ID="$SESSION" "$PCLI" scratchpad open --slug "$SLUG" 2>/dev/null)"
  printf '# malformed on purpose: no REVIEW_WT, no PR_REF\n' >"$DIR/$LEAF"
  RC="$(run_teardown "$GATE" "$SESSION")"
  expect "$RC" nonzero "$GATE D malformed handle -> non-zero"

  # G — a well-formed handle describing a DIFFERENT PR. This is #5416's teardown half: the tree it
  # names is real and live, and the pre-fix code `rm -rf`'d it. Nothing may be removed, and the run
  # must not call that a no-op. Scoped to `review-code` — it is the gate that carries the guard, and
  # letting the other two reach their `rm -rf`/`update-ref -d` here would mutate the primary's refs.
  if [ "$GATE" = review-code ]; then
    SESSION="proof-g-$GATE-$$"
    DIR="$(CLAUDE_CODE_SESSION_ID="$SESSION" "$PCLI" scratchpad open --slug "$SLUG" 2>/dev/null)"
    SIBLING_PR=$((PR + 1))
    OTHER="$(mktemp -d "${TMPDIR:-/tmp}/review-head-$SIBLING_PR-XXXXXX")"
    printf 'REVIEW_WT=%s\nPR_REF=refs/pr/%s-sibling\nHANDLE_PR=%s\n' "$OTHER" "$SIBLING_PR" "$SIBLING_PR" >"$DIR/$LEAF"
    RC="$(run_teardown "$GATE" "$SESSION")"
    if [ "$RC" -ne 0 ] && [ -d "$OTHER" ]; then
      ok "$GATE G sibling-PR handle -> refused, sibling tree intact (rc=$RC)"
    else
      bad "$GATE G expected a refusal with the sibling tree kept (rc=$RC, tree-present=$([ -d "$OTHER" ] && echo yes || echo no))"
    fi
    rm -rf "$OTHER"
  fi

  # E — the happy path, inside a throwaway repo so the primary's worktrees and refs are untouched.
  SESSION="proof-e-$GATE-$$"
  DIR="$(CLAUDE_CODE_SESSION_ID="$SESSION" "$PCLI" scratchpad open --slug "$SLUG" 2>/dev/null)"
  SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/teardown-proof.XXXXXX")"
  git -C "$SANDBOX" init -q
  git -C "$SANDBOX" -c user.email=proof@invalid -c user.name=proof commit -q --allow-empty -m proof
  # The fixture is PR-shaped — `refs/pr/<pr>-<nonce>`, `review-head-<pr>-<id>`, `HANDLE_PR` — because
  # that is what a real materialization writes, and what `review-code`'s guard requires before it
  # will remove anything (#5416).
  REF="refs/pr/$PR-proof$$"
  git -C "$SANDBOX" update-ref "$REF" HEAD
  TREE="$SANDBOX/review-head-$PR-proof"
  mkdir -p "$TREE"
  printf 'REVIEW_WT=%s\nPR_REF=%s\nHANDLE_PR=%s\n' "$TREE" "$REF" "$PR" >"$DIR/$LEAF"
  (cd "$SANDBOX" && CLAUDE_CODE_SESSION_ID="$SESSION" bash "$TD" "$PR" >/dev/null 2>&1)
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
