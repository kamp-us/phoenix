#!/usr/bin/env bash
# §RO-iso — `iso_preflight`, extracted from `gh-issue-intake-formats.md` (epic #4435 phase 1, #4450).
# The *why* — why the LOUD refusal keys on the agent-type alone, and why self-provisioning is not the
# remedy — stays in that contract's §RO-iso prose (ADR 0172, #2443/#2446/#3406); the per-clause
# comments travelled with the shell.
#
# MECHANICAL MOVE. Every moved line is byte-identical to the fence it came from and sits at column 0,
# so a reviewer can diff it against the deleted block directly. Verbification is phase 2 (#1929,
# ADR 0228). Do not "improve" it here.
#
# DUAL-MODE (ADR 0232) — the why is `.patterns/skill-script-shell-shape.md` § The dual-mode shape.
#   EXECUTED:  bash ./claude-plugins/kampus-pipeline/skills/shared/scripts/iso-preflight.sh <surface>
#              stdout ⇒ the function's own scope line, then `ISO_PREFLIGHT=OK`; on a refusal the
#              LOUD ROUTED BLOCKER lines go to stderr, stdout carries no `ISO_PREFLIGHT=OK`, and the
#              exit status is 1. This guard's whole contract is that status — read it first.
#   SOURCED:   the sanctioned in-script edge — `review-code/scripts/materialize-head.sh` and
#              `ship-it/scripts/step0-preflight.sh` source this file for `iso_preflight`. Unchanged,
#              including which stream each of its lines lands on.
# No EXIT trap — under bash 3.2 a cleanup trap's last command becomes the script's status,
# laundering a `set -u` abort into exit 0 (#4476, class #4479), which would silently disarm it.

if [ "${BASH_SOURCE[0]}" = "$0" ]; then set -uo pipefail; fi   # executed mode only (ADR 0232)

# iso_preflight <surface>: the shared primary-checkout fail-closed guard every head-materializing
# gate runs BEFORE its first head fetch / `git worktree add` (§RO). Reviewer/shipper sibling of
# write-code's Step-4 wt_preflight (ADR 0172) — the SAME git-dir==common-dir detection, the SAME
# isolation-expected fork. Read-only (git rev-parse only); safe to re-run.
iso_preflight() {
  local surface="$1" gitdir common iso=0
  gitdir="$(git rev-parse --absolute-git-dir 2>/dev/null)" || {
    echo "$surface iso_preflight FAILED (fail-closed): not inside a git repository — refusing to materialize a PR head." >&2; return 1; }
  common="$(git rev-parse --git-common-dir 2>/dev/null)"
  case "$common" in /*) ;; *) common="$(pwd)/$common" ;; esac   # normalize a relative `.git` (older git)
  common="$(cd "$common" && pwd)"
  # Isolation was EXPECTED when the run is under an isolation-asserting pipeline agent-type —
  # coder/reviewer/shipper all spawn isolation:worktree (agents/{coder,reviewer,shipper}.md) — read
  # from the harness-set $CLAUDE_CODE_AGENT (stable across an agent's Bash calls, unlike a shell
  # export), corroborated by a set $WORKTREE_ROOT. A genuine standalone run (a human /review-code,
  # /ship-it) matches NEITHER. Critically the LOUD refusal fires on the AGENT-TYPE ALONE and does
  # NOT key on $WORKTREE_ROOT being set — so the #2440 no-op (isolation requested, $WORKTREE_ROOT
  # unset, which also disarms the $WORKTREE_ROOT-keyed worktree-guard) still trips this preflight;
  # it is then the sole surviving layer, exactly as in write-code (ADR 0172).
  # The THIRD clause is the env-independent corroboration — parity with the repo-side guard's
  # `isIsolationExpected` (bash-pin.ts) and write-code's Step-4 detector (#3406): a NESTED/renamed
  # spawn inherits the PARENT's agent-type string (e.g. `crew-engineering-manager`, ADR 0189), so the
  # NAME match goes inert for it — but any agent-context run ($CLAUDE_CODE_AGENT non-empty) sitting on
  # the PRIMARY checkout (gitdir == common) is a broken/absent worktree whatever its inherited name,
  # and this clause arms regardless of the string. Do NOT hard-code an agent-type name to patch a
  # rename — the corroboration removes the coupling rather than relocating it (#3406, #2462).
  case "$CLAUDE_CODE_AGENT" in *coder*|*reviewer*|*shipper*) iso=1 ;; esac
  [ -n "$WORKTREE_ROOT" ] && iso=1
  [ -n "$CLAUDE_CODE_AGENT" ] && [ "$gitdir" = "$common" ] && iso=1
  echo "$surface iso_preflight: git-dir=$gitdir common-dir=$common cwd=$(pwd) isolation-expected=$iso (agent=${CLAUDE_CODE_AGENT:-unset} worktree-root=${WORKTREE_ROOT:+set})"
  if [ "$gitdir" = "$common" ]; then
    if [ "$iso" = 1 ]; then
      echo "$surface iso_preflight FAILED (fail-closed, LOUD): worktree isolation was EXPECTED (agent=${CLAUDE_CODE_AGENT:-?}, worktree-root=${WORKTREE_ROOT:+set}) but this run is on the PRIMARY checkout (git-dir == common-dir) and \$WORKTREE_ROOT is unset." >&2
      echo "  Refusing to fetch / \`git worktree add\` the PR head here — the #2440 harness no-op left this $surface spawn in the shared primary checkout, and a head-materialization run there is the #2452/#2453 primary-checkout-detach surface. The \$WORKTREE_ROOT-keyed repo-side worktree-guard is disarmed by the same no-op, so THIS preflight is the only surviving layer." >&2
      echo "  Do NOT self-provision a worktree to route around it — that hides the harness failure and leaves the primary-corruption defense collapsed to one, invisibly (#2270)." >&2
      echo "  ROUTED BLOCKER — surface UP to the operator/EM: 'harness worktree provisioning no-op'd for a $surface spawn (isolation expected, \$WORKTREE_ROOT unset); the out-of-repo harness half (#2440) needs attention. Do NOT blindly retry the same spawn.'" >&2
      return 1
    fi
    # isolation NOT expected ⇒ a genuine standalone run on the owner's primary checkout. This gate
    # never mutates the launched tree (§RO): it materializes the head ONLY into a throwaway worktree
    # / per-run ref, so operating from the primary checkout is safe here — proceed, no LOUD stop.
    echo "$surface iso_preflight: standalone run on the primary checkout — proceeding read-only via the §RO throwaway-worktree / per-run-ref materialization (the launched tree is never mutated)." >&2
  fi
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  # The function reads $CLAUDE_CODE_AGENT and $WORKTREE_ROOT UNDEFAULTED, so under this mode's
  # `set -u` an unset one aborts before the guard can answer at all. Bind each to its own current
  # value — empty when unset — so the executed form evaluates exactly the branches a no-options
  # sourced caller gets. The body stays untouched: the undefaulted reads under a sourced `set -u`
  # caller are a separate pre-existing defect, filed rather than fixed from here.
  CLAUDE_CODE_AGENT="${CLAUDE_CODE_AGENT-}"
  WORKTREE_ROOT="${WORKTREE_ROOT-}"
  iso_preflight "${1:?iso-preflight.sh: no <surface> argument — refusing to run an unnamed preflight}" || exit 1
  echo "ISO_PREFLIGHT=OK"
fi
