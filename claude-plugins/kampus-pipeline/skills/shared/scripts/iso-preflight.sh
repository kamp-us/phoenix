#!/usr/bin/env bash
# §RO-iso — `iso_preflight`, extracted from `gh-issue-intake-formats.md` (epic #4435 phase 1, #4450).
# The *why* — why the LOUD refusal keys on the agent-type alone, and why self-provisioning is not the
# remedy — stays in that contract's §RO-iso prose (ADR 0172, #2443/#2446/#3406); the per-clause
# comments travelled with the shell.
#
# MECHANICAL MOVE, since amended once. Every line arrived byte-identical to the fence it came from;
# #4591 then changed the reads (not the policy) so the guard can answer under a `set -u` caller —
# see the function header. Verbification is still phase 2 (#1929, ADR 0228); nothing else here is
# an invitation to "improve" it.
#
# DUAL-MODE (ADR 0232) — the why is `.patterns/skill-script-shell-shape.md` § The dual-mode shape.
#   EXECUTED:  bash ./claude-plugins/kampus-pipeline/skills/shared/scripts/iso-preflight.sh <surface>
#              stdout ⇒ the function's own scope line, then `ISO_PREFLIGHT=OK`; on a refusal the
#              LOUD ROUTED BLOCKER lines go to stderr, stdout carries no `ISO_PREFLIGHT=OK`, and the
#              exit status is 1. This guard's whole contract is that status — read it first.
#   SOURCED:   the sanctioned in-script edge — `review-code`/`review-trivial`'s `materialize-head.sh`
#              and `ship-it/scripts/step0-preflight.sh` source this file for `iso_preflight`. The
#              stream split is unchanged: the scope line is the only stdout, every refusal and every
#              narration line is stderr. What #4591 changed is that a `set -u` sourcing caller now
#              gets the guard's ANSWER on all three env states instead of an unbound-variable abort.
# No EXIT trap — under bash 3.2 a cleanup trap's last command becomes the script's status,
# laundering a `set -u` abort into exit 0 (#4476, class #4479), which would silently disarm it.

if [ "${BASH_SOURCE[0]}" = "$0" ]; then set -uo pipefail; fi   # executed mode only (ADR 0232)

# iso_preflight <surface>: the shared primary-checkout fail-closed guard every head-materializing
# gate runs BEFORE its first head fetch / `git worktree add` (§RO). Reviewer/shipper sibling of
# write-code's Step-4 wt_preflight (ADR 0172) — the SAME git-dir==common-dir detection, the SAME
# isolation-expected fork. Read-only (git rev-parse only); safe to re-run.
#
# EVERY read below is defaulted — the sourced-class rule in `.patterns/skill-script-shell-shape.md`,
# and the whole of #4591's fix. The check that rule asks you to make, made here: defaulting cannot
# fail this guard OPEN, because the two env signals appear ONLY in clauses that RAISE `iso`, so they
# can arm the refusal and never grant a pass — the pass comes from the env-independent
# `git-dir != common-dir` plumbing (#3458), which no env read can forge.
iso_preflight() {
  local surface="${1-}" gitdir common iso=0 agent wtroot agent_obs wtroot_obs
  [ -n "$surface" ] || {
    echo "iso_preflight FAILED (fail-closed): called with no <surface> argument — refusing to run an unnamed preflight." >&2; return 1; }
  gitdir="$(git rev-parse --absolute-git-dir 2>/dev/null)" || {
    echo "$surface iso_preflight FAILED (fail-closed): not inside a git repository — refusing to materialize a PR head." >&2; return 1; }
  common="$(git rev-parse --git-common-dir 2>/dev/null)"
  case "$common" in /*) ;; *) common="$(pwd)/$common" ;; esac   # normalize a relative `.git` (older git)
  # Resolve BOTH sides PHYSICALLY before comparing them, and refuse if either won't resolve. Measured
  # on darwin: `--absolute-git-dir` answers physically (/var -> /private/var) while `cd … && pwd`
  # answers logically, so a checkout reached through a symlinked path made the two differ ON THE
  # PRIMARY TREE — the guard then read the primary as a linked worktree and passed, with neither the
  # LOUD refusal nor the standalone note firing. That is a fail-OPEN, and an unresolvable `cd` was a
  # second one (it left `common` empty, which never equals `gitdir`). `git-dir == common-dir` only
  # means what §RO-iso says it means when both sides are the same kind of path (#4591).
  gitdir="$(cd "$gitdir" 2>/dev/null && pwd -P)" || {
    echo "$surface iso_preflight FAILED (fail-closed): git-dir does not resolve to a readable directory — refusing to compare an unresolvable path." >&2; return 1; }
  common="$(cd "$common" 2>/dev/null && pwd -P)" || {
    echo "$surface iso_preflight FAILED (fail-closed): git-common-dir does not resolve to a readable directory — refusing to compare an unresolvable path." >&2; return 1; }
  # Three-way observability, resolved before any clause reads the values (the report-an-absent-signal
  # -three-ways rule in `.patterns/skill-script-shell-shape.md`). Here that distinction decides
  # whether the standalone branch below is a conclusion or a guess, which is why it is computed even
  # though no clause branches on it.
  agent="${CLAUDE_CODE_AGENT-}"
  wtroot="${WORKTREE_ROOT-}"
  case "${CLAUDE_CODE_AGENT+d}${agent:+v}" in
    dv) agent_obs="$agent" ;;  d) agent_obs='empty(exported-blank)' ;;  *) agent_obs='UNSET(never-exported)' ;;
  esac
  case "${WORKTREE_ROOT+d}${wtroot:+v}" in
    dv) wtroot_obs='set' ;;    d) wtroot_obs='empty(exported-blank)' ;; *) wtroot_obs='UNSET(never-exported)' ;;
  esac
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
  case "$agent" in *coder*|*reviewer*|*shipper*) iso=1 ;; esac
  [ -n "$wtroot" ] && iso=1
  [ -n "$agent" ] && [ "$gitdir" = "$common" ] && iso=1
  echo "$surface iso_preflight: git-dir=$gitdir common-dir=$common cwd=$(pwd) isolation-expected=$iso (agent=$agent_obs worktree-root=$wtroot_obs)"
  if [ "$gitdir" = "$common" ]; then
    if [ "$iso" = 1 ]; then
      echo "$surface iso_preflight FAILED (fail-closed, LOUD): worktree isolation was EXPECTED (agent=$agent_obs, worktree-root=$wtroot_obs) but this run is on the PRIMARY checkout (git-dir == common-dir)." >&2
      echo "  Refusing to fetch / \`git worktree add\` the PR head here — the #2440 harness no-op left this $surface spawn in the shared primary checkout, and a head-materialization run there is the #2452/#2453 primary-checkout-detach surface. The \$WORKTREE_ROOT-keyed repo-side worktree-guard is disarmed by the same no-op, so THIS preflight is the only surviving layer." >&2
      echo "  Do NOT self-provision a worktree to route around it — that hides the harness failure and leaves the primary-corruption defense collapsed to one, invisibly (#2270)." >&2
      echo "  ROUTED BLOCKER — surface UP to the operator/EM: 'harness worktree provisioning no-op'd for a $surface spawn (isolation expected, worktree-root=$wtroot_obs); the out-of-repo harness half (#2440) needs attention. Do NOT blindly retry the same spawn.'" >&2
      return 1
    fi
    # isolation NOT expected ⇒ a genuine standalone run on the owner's primary checkout. This gate
    # never mutates the launched tree (§RO): it materializes the head ONLY into a throwaway worktree
    # / per-run ref, so operating from the primary checkout is safe here — proceed, no LOUD stop.
    echo "$surface iso_preflight: no isolation-expected evidence (agent=$agent_obs worktree-root=$wtroot_obs) ⇒ read as a standalone run on the owner's primary checkout — proceeding read-only via the §RO throwaway-worktree / per-run-ref materialization (the launched tree is never mutated)." >&2
    echo "  This is the ONE branch that concludes from an ABSENCE, so it names the absence rather than reporting a check it did not make: an isolation-asserting spawn whose env never reached this shell looks identical here. It stays a proceed because the branch is read-only by construction (ADR 0172), and the two env states are printed above so the difference is recoverable from the log." >&2
  else
    echo "$surface iso_preflight CONFIRMED: LINKED worktree (git-dir != common-dir) — isolation established from git plumbing ALONE, independent of \$CLAUDE_CODE_AGENT ($agent_obs) and \$WORKTREE_ROOT ($wtroot_obs). Neither env signal can manufacture this pass; they only ever ARM the refusal above, which is why defaulting their reads cannot fail this guard open (#4591)." >&2
  fi
  return 0
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  # No pre-binding of $CLAUDE_CODE_AGENT / $WORKTREE_ROOT here any more. The function defaults every
  # read itself (#4591), so both modes evaluate the same branches — and the pre-bind is now actively
  # harmful: `VAR="${VAR-}"` DECLARES the variable, turning "never exported" into "exported blank"
  # and erasing exactly the distinction the scope line was taught to report.
  iso_preflight "${1-}" || exit 1
  echo "ISO_PREFLIGHT=OK"
fi
