#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2016,SC2086
# The per-mutation worktree preflight — the guard every commit / branch op / verified-push in
# Steps 4–5 and repair R2/R3 is gated on. EXECUTED, never sourced (ADR 0232): it runs the whole
# fail-closed classification here and prints the resolved worktree ROOT on stdout; every
# diagnostic and every refusal line goes to stderr. The caller consumes that root and addresses
# git at it explicitly (`git -C "$WT" …`) — the DECISION stays in the script, only its EFFECT
# moves to the caller, which is what the stdout contract (#4510) is for. A subprocess cannot
# change its parent's directory, and ADR 0232 retires leave-state-in-the-caller's-shell as a
# design property outright.
#
# The guard body below is VERBATIM from write-code/SKILL.md's per-mutation-preflight blockquote
# (epic #4435 phase 1, #4449) — every refusal branch and both `cd`s intact. The internal `cd "$WT"`
# stays because the defence-in-depth plumbing after it reads the tree it lands in.
#
# `set -uo pipefail`, never `-e`: errexit aborts a fail-closed branch before it prints its BLOCKING
# line, and paired with a cleanup EXIT trap it launders a `set -u` abort into exit 0
# (`.patterns/skill-script-shell-shape.md`). No EXIT trap is installed here either.
set -uo pipefail
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

# Resolve MY worktree by IDENTITY, never from cwd (#4398). `git rev-parse --show-toplevel` answers
# "where is the cwd" — which a between-calls reset makes a different question from "which tree is
# mine". Deriving $WT from it and then re-deriving the toplevel to compare against is one answer
# checked against itself: always equal, so its failure branch could never print. The stamp is
# CONTENT written once when $WT was trustworthy, so these two operands can genuinely differ.
lane_worktree() {   # print the absolute root of the worktree stamped with THIS lane's session id
  common="$(git rev-parse --git-common-dir 2>/dev/null)" || return 1
  case "$common" in /*) ;; *) common="$(pwd -P)/$common" ;; esac
  common="$(cd "$common" && pwd -P)" || return 1   # -P: git answers in PHYSICAL paths, so must we
  hits=""
  for st in "$common"/worktrees/*/kampus-lane; do
    [ -f "$st" ] || continue
    [ "$(cat "$st")" = "$CLAUDE_CODE_SESSION_ID" ] || continue
    gd="$(cat "${st%/kampus-lane}/gitdir")" || return 1   # "<worktree-root>/.git"
    hits="$hits $(cd "${gd%/.git}" && pwd -P)"
  done
  set -- $hits
  [ "$#" -eq 1 ] || return 1   # 0 ⇒ no tree is mine; >1 ⇒ ambiguous. Both REFUSE (fail-closed).
  printf '%s\n' "$1"
}
wt_preflight() {   # MANDATED before every git commit/push/branch op — fail-closed, re-correcting cwd
  : "${CLAUDE_CODE_SESSION_ID:?wt_preflight FAILED (fail-closed): no session id — no lane identity to verify a worktree against}"
  # CLASSIFY THE AMBIENT TREE FIRST — the lane-identity assertions live here, because this is the
  # only place THESE operands can differ. `$AMB_STAMP` is a file some lane wrote when its worktree
  # was proven; `$CLAUDE_CODE_SESSION_ID` is the process env. After the corrective `cd` below these
  # two agree BY CONSTRUCTION, so re-checking THEM down there would be checking a value against its
  # own derivation — which is exactly what shipped, and why the sibling-tree refusal never printed
  # (#4398). That is a fact about these operands, not about position: the post-`cd` refusal below
  # reads independent operands and does fire.
  AMB_GITDIR="$(git rev-parse --absolute-git-dir 2>/dev/null)"
  AMB_COMMON="$(git rev-parse --git-common-dir 2>/dev/null)"
  case "$AMB_COMMON" in ""|/*) ;; *) AMB_COMMON="$(pwd -P)/$AMB_COMMON" ;; esac
  [ -n "$AMB_COMMON" ] && AMB_COMMON="$(cd "$AMB_COMMON" && pwd -P)"   # -P: compare like for like with git's physical answer
  AMB_STAMP="$(cat "$AMB_GITDIR/kampus-lane" 2>/dev/null)"
  echo "wt_preflight: ambient=$(git rev-parse --show-toplevel 2>/dev/null || echo '<not a repo>') ambient-git-dir=${AMB_GITDIR:-<none>} ambient-stamp=${AMB_STAMP:-<none>} lane=$CLAUDE_CODE_SESSION_ID"
  # THE SIBLING-TREE REFUSAL: cwd sits in a LINKED worktree that is not mine. The primary checkout
  # is the harness's documented reset target and is corrected below; a sibling lane's tree is NOT
  # explained by anything, so stop rather than mutate next to a live lane (#832, #3458/#3580).
  if [ -n "$AMB_GITDIR" ] && [ "$AMB_GITDIR" != "$AMB_COMMON" ] && [ "$AMB_STAMP" != "$CLAUDE_CODE_SESSION_ID" ]; then
    echo "wt_preflight FAILED (fail-closed): cwd is inside worktree $(git rev-parse --show-toplevel), stamped '${AMB_STAMP:-<none>}' — a SIBLING lane's tree, not my lane ($CLAUDE_CODE_SESSION_ID). Refusing to mutate." >&2
    return 1
  fi
  # cwd is my own tree or the PRIMARY checkout (the between-calls reset). Resolve my lane by
  # identity and cd there — the correction. A miss REFUSES: no tree is mine (unprovisioned, torn
  # down, or a foreign session), or several are (ambiguous).
  WT="$(lane_worktree)" || { echo "wt_preflight FAILED (fail-closed): no single worktree carries this lane's stamp ($CLAUDE_CODE_SESSION_ID) — the opening preflight never ran, or its tree is gone. Refusing to mutate." >&2; return 1; }
  cd "$WT" || { echo "wt_preflight FAILED: cannot cd to worktree root $WT" >&2; return 1; }
  # DEFENCE IN DEPTH — the resolved lane must not BE the primary checkout. This sits after the
  # `cd` and is still a genuine assertion, because its operands do not come from the cwd: it
  # tests `lane_worktree`'s ANSWER with two DIFFERENT plumbing queries whose results coincide
  # only on the primary. `lane_worktree` returns whatever `worktrees/<name>/gitdir` names, so an
  # entry naming the primary root, stamped with this lane, resolves here — and this refuses.
  # Demonstrated firing in PR #4419's review; do not delete it as "true by construction" (#4398).
  RES_GITDIR="$(git rev-parse --absolute-git-dir 2>/dev/null)" || { echo "wt_preflight FAILED (fail-closed): resolved lane $WT is not inside a git repository — refusing to mutate." >&2; return 1; }
  RES_COMMON="$(git rev-parse --git-common-dir 2>/dev/null)"
  case "$RES_COMMON" in /*) ;; *) RES_COMMON="$(pwd -P)/$RES_COMMON" ;; esac
  RES_COMMON="$(cd "$RES_COMMON" && pwd -P)"
  [ "$RES_GITDIR" != "$RES_COMMON" ] || { echo "wt_preflight FAILED (fail-closed): this lane's stamp resolved to the PRIMARY checkout ($WT) — git-dir == common-dir. Refusing to mutate." >&2; return 1; }
  echo "wt_preflight OK: mutating my lane at $WT (git-dir $RES_GITDIR)"
}

# `>&2` routes the guard's whole narration — the ambient-classification line and every refusal —
# to stderr WITHOUT touching a moved line, leaving stdout carrying exactly one thing: the root.
# Silence on stdout plus a non-zero exit is therefore UNKNOWN/REFUSED, never a permissive answer.
wt_preflight >&2 || exit 1
printf '%s\n' "$WT"
