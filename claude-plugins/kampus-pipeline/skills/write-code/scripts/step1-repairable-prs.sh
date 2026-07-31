#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2016,SC2086,SC2162
# Step 1's pre-pick exception: print every open PR you authored whose LATEST gate verdict is an
# unaddressed, uncapped FAIL — the arc that must be repaired before any new issue is picked.
# EXECUTED, never sourced (ADR 0232): stdout IS that list, one `#<PR> review-<gate> FAIL` per line,
# and every diagnostic goes to stderr. Empty stdout with a non-zero exit is UNKNOWN, never
# "nothing to repair" — which is why the caller carries `|| exit 1`.
#
# Extracted from write-code/SKILL.md's Step 1 fenced block (epic #4435 phase 1, #4449) — one of the
# two blocks PR #4503 left in the markdown while it overlapped the #4372 lane. Replacing this glue
# with verbs is still phase 2 (#1929); nothing below is rewritten toward that.
#
# `set -uo pipefail`, never `-e`: errexit would abort the §ZS refusals before they print
# (`.patterns/skill-script-shell-shape.md`). No EXIT trap — under bash 3.2 a cleanup trap's last
# command becomes the script's status, laundering a `set -u` abort into exit 0 (#4476, class #4479).
set -uo pipefail
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

# `$REPO` no longer arrives from a sourcing caller — resolve it here and fail closed rather than
# address `repos//pulls`, which would answer an empty scan that reads as "no repairable PR".
REPO="$(kp_repo)" || exit 1

ME=$(gh api user --jq '.login')
# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314). The shim's own
# three-tier ladder (in-repo bin → installed bin → the pinned `pnpm dlx`, hooks/pin.sh) decides WHICH
# build runs, so no version is pinned here (#3653; ADR 0062/0064; epic #994). Each per-(PR, gate)
# FAIL-bound-to-head resolution below delegates to `pipeline-cli verdict read` (ACL author-gate +
# latest-wins + SHA-staleness, ADR 0055/0058; its unit tests are the contract).
PCLI="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/bin/pipeline-cli"
# GATE-CRITICAL (§CLI): this scan's wrapper turns non-zero into "nothing to repair", so an
# unresolved CLI would read as a clean scan and the run would fall through to new work while an
# unaddressed FAIL sits open. Refuse up front — "could not run" is never a verdict.
[ -x "$PCLI" ] || {
  echo "pipeline-cli: UNRESOLVED at '$PCLI' — the repairable-PR scan has NO result." >&2
  echo "  Resolve to UNKNOWN, never to 'no FAIL'. This is a resolution gap, NOT worktree teardown (§CLI)." >&2
  exit 127
}
# §CPREAD's `cp_changed_files`, sourced from its canonical home — no skill-local copy to drift
# (#4489). It feeds the per-PR §CP-ness derivation inside the loop.
# Reached by the documented BASH_SOURCE-relative idiom, the one form ADR 0230's cycle validators
# resolve statically; the interpolated `${CLAUDE_PLUGIN_ROOT:-…}` shape this replaced could not be,
# so it dropped write-code out of `validate-cycle-absence`'s scanned scope entirely.
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/scripts" && pwd)/cp-read.sh"
# open PRs you authored; print each one whose latest verdict in EITHER namespace is FAIL,
# UNLESS it has already hit the N=3 repair cap (then it's a human's, not yours to re-pick)
gh api "repos/$REPO/pulls?state=open&per_page=100" \
  --jq ".[] | select(.user.login==\"$ME\") | .number" | while read PR; do
  # The N=3 FAIL-round count is the one thing `verdict read` does NOT do (it resolves the latest
  # verdict, it does not count rounds) — genuinely more than a single (PR, gate) resolution, so it
  # stays inline. Author-gate the FAIL markers to write+ collaborators (ADR 0055, supersedes 0051)
  # so a forged review-(code|doc|skill): FAIL can't inflate the count; an empty authorized set counts
  # zero rounds — fail-closed. Cluster by timestamp gap (>120s = new round), per fix-round not per
  # marker (a both-namespace round counts once), the same identity the Bounding count uses.
  comments_file=$(mktemp)
  gh api "repos/$REPO/issues/$PR/comments?per_page=100" > "$comments_file"
  markerAuthors=$(jq -r '[.[]
      | select(.body | test("^\\s*\\**\\s*review-(code|doc|skill):\\s*(PASS|FAIL)"; "i"))
      | .user.login] | unique | .[]' "$comments_file")
  authorized='[]'
  while IFS= read -r a; do
    [ -z "$a" ] && continue
    perm=$(gh api "repos/$REPO/collaborators/$a/permission" --jq .permission 2>/dev/null)
    case "$perm" in
      admin|maintain|write) authorized=$(jq -c --arg a "$a" '. + [$a]' <<<"$authorized") ;;
    esac
  done <<<"$markerAuthors"
  ROUNDS=$(jq --argjson authorized "$authorized" \
    '[.[] | select(.user.login | IN($authorized[]))
          | select(.body | test("^\\s*\\**\\s*review-(code|doc|skill):\\s*FAIL"; "i"))
          | .created_at | sub("\\..*Z$";"Z") | fromdateiso8601]
     | sort
     | reduce .[] as $t ({n:0, prev:null};
         if (.prev == null) or ($t - .prev) > 120
         then {n:(.n+1), prev:$t} else {n:.n, prev:$t} end)
     | .n' "$comments_file")
  [ "$ROUNDS" -ge 3 ] && continue   # at the cap → already escalated to a human, excluded from the scan
  # §CP-ness is part of the (PR, gate, head, §CP-ness) tuple `verdict read` resolves (#4049). On a §CP
  # PR the pass is the SHA-less ADVISORY, which a read without --cp cannot see at all — so a FAIL
  # discharged by a BODY-ONLY repair (which deliberately never moves the head, so ADR 0058 staleness
  # can never retire it) reads as a standing FAIL forever and pulls this scan into a phantom repair.
  # Derive it per PR, fail-closed on BOTH fallible inputs: the changed-file list is a network read, so
  # it comes from `cp_changed_files` and never a bare `gh … | cp-classify` pipe, which with pipefail
  # off hands the verb gh's STDOUT error document and answers `not-control-plane` on an unread list
  # (#4216); and only the PROVEN `not-control-plane` state word drops the flag — never `… ||
  # CP_FLAG=""` on mere non-zero, which fires on a usage error (1) or a missing bin (127).
  # `>&2` routes only the §ZS scope LINE, not the result: `cp_changed_files` returns its file list in
  # $CP_FILES, and this loop's stdout is the repairable-PR list the caller reads. The scope line is
  # still emitted (§ZS #1), on the same stream as this helper's failure lines.
  if ! cp_changed_files "$REPO" "$PR" >&2; then
    CP_STATE=unknown   # the input never arrived ⇒ UNKNOWN ⇒ hold as §CP (never `not-control-plane`)
  else
    CP_STATE="$(printf '%s\n' "$CP_FILES" | "$PCLI" cp-classify classify --repo "$REPO" 2>/dev/null)"
  fi
  if [ "$CP_STATE" = "not-control-plane" ]; then CP_FLAG=""; else CP_FLAG="--cp"; fi
  # resolve each namespace's latest current-head verdict through the shared verb — exit 0 iff HEAD
  # carries a current FAIL in that gate (a stale / SHA-less / PASS / none verdict exits non-zero).
  # stderr is NOT discarded and 127 is read apart from an ordinary negative: with `2>&1` swallowing
  # it, a `command not found` was byte-identical to "no FAIL verdict" and the PR dropped out of the
  # scan silently (§CLI exit-code taxonomy — "could not run" is never a verdict; #4398, #4236).
  for G in code doc skill; do
    "$PCLI" verdict read --pr "$PR" --gate "$G" $CP_FLAG --expect FAIL >/dev/null
    RC=$?
    case $RC in
      0)   echo "#$PR review-$G FAIL" ;;
      127) echo "verdict read could not run (127) for #$PR/$G — UNKNOWN, not 'no FAIL'. Stop and route the blocker (§CLI)." >&2; exit 127 ;;
    esac
  done
done
