#!/usr/bin/env bash
# heal-ci Step 4's twin-suppression guard: is a write-code repair already in flight on this PR?
#
# usage: active-repair.sh <pr>
#
# Prints four `KEY=value` lines on stdout — VERDICT_UNKNOWN, CODE_FAIL, DOC_FAIL, ROUNDS. Those four
# ARE the answer heal-ci's prose reads (`ROUNDS < 3` plus a current-head FAIL in either namespace ⇒
# an active repair ⇒ route the comment, do not file a twin).
#
# FAIL-CLOSED: the permissive reading here is "no repair in flight", and that branch FILES a twin
# defect against a live repair — so an answer this script could not produce must never arrive as
# one. A non-zero exit prints NOTHING on stdout and its diagnostic on stderr (§ZS / ADR 0092);
# `VERDICT_UNKNOWN=1` is the in-band form of the same rule for the one input that resolves
# per-namespace rather than per-run.
#
# Extracted from heal-ci/SKILL.md (#4454, epic #4435). Executed, never sourced (ADR 0232).
# The moved lines' shellcheck findings moved with them: `$VERDICT` / `$CP_FLAG` / the `gh api`
# path expand to argument WORDS on purpose, and quoting them would be a rewrite — phase 2 (#1929),
# not this byte-move. SC1007/SC1091 are the shared `CDPATH= cd` source idiom's, as in every
# sibling script.
# shellcheck disable=SC1007,SC1091,SC2086
set -uo pipefail
# shellcheck source=../../../lib/common.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

HERE="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
[ -n "$HERE" ] || { echo "heal-ci: could not resolve this script's own directory — the active-repair check did NOT run." >&2; exit 1; }
KP_ROOT="$(CDPATH= cd -- "$HERE/../../.." && pwd)"
[ -n "$KP_ROOT" ] || { echo "heal-ci: could not resolve the plugin root — the active-repair check did NOT run." >&2; exit 1; }

[ "$#" -ge 1 ] || {
	echo "heal-ci: active-repair.sh needs a PR number — the check did NOT run (UNKNOWN, never 'no repair in flight')." >&2
	echo "usage: active-repair.sh <pr>" >&2
	exit 2
}
PR="$1"
REPO="$(kp_repo)" || { echo "heal-ci: target repo unresolved — the active-repair check did NOT run (UNKNOWN, never 'no repair in flight')." >&2; exit 1; }

# is a write-code repair already in flight on this PR? (PR runs only) — resolve the verdict the
# EXACT way write-code Step R1 does, by delegating each (PR, gate) FAIL-bound-to-head resolution to
# `pipeline-cli verdict read` (ACL author-gate + latest-wins + SHA-staleness, ADR 0055/0058). Resolve
# the CLI via the `bin/pipeline-cli` shim — in-repo bin, else the installed bin, else the pinned
# `pnpm dlx` fallback reading the one pin (hooks/pin.sh); no version pinned here (#3653; ADR 0062/0064).
VERDICT="$KP_ROOT/bin/pipeline-cli verdict"

# §CP-ness is part of the (PR, gate, head, §CP-ness) tuple `verdict read` resolves, so pass it here
# exactly as write-code Step R1 does (#4049): on a §CP PR the pass is the SHA-less ADVISORY, invisible
# without --cp, so a FAIL discharged by a BODY-ONLY repair (the head never moves, so ADR 0058
# staleness cannot retire it) would read as a live repair forever and suppress every defect filing on
# that PR. Fail-closed on BOTH fallible inputs, exactly as write-code Step R1 is: the changed-file
# list comes from §CPREAD's `cp_changed_files`, sourced from its canonical home (#4489), because a
# bare `gh … | cp-classify` pipe hands the verb gh's STDOUT error document to classify and answers
# `not-control-plane` on an unread list (#4216); and only the PROVEN `not-control-plane` state word
# drops the flag — never a bare non-zero test, which fires on a usage error (1) or a missing bin (127).
# `>&2` routes only the §ZS scope LINE — the result arrives in $CP_FILES, and THIS script's stdout is
# the four-line answer its caller reads, so a diagnostic on it would corrupt the answer.
. "$KP_ROOT/skills/shared/scripts/cp-read.sh"
if ! cp_changed_files "$REPO" "$PR" >&2; then
  CP_STATE=unknown   # the input never arrived ⇒ UNKNOWN ⇒ hold as §CP (never `not-control-plane`)
else
  CP_STATE="$(printf '%s\n' "$CP_FILES" \
    | "$KP_ROOT/bin/pipeline-cli" cp-classify classify --repo "$REPO" 2>/dev/null)"
fi
if [ "$CP_STATE" = "not-control-plane" ]; then CP_FLAG=""; else CP_FLAG="--cp"; fi

# a namespace is an active-repair FAIL iff its latest authorized verdict is FAIL bound to the current
# head — exit 0 from `verdict read … --expect FAIL`. A stale / SHA-less / PASS / none verdict exits
# non-zero, so it is correctly NOT an active repair, matching write-code's no-op on it.
CODE_FAIL_JSON="$($VERDICT read --pr "$PR" --gate code $CP_FLAG --expect FAIL 2>/dev/null)" && CODE_FAIL=1 || CODE_FAIL=0
DOC_FAIL_JSON="$($VERDICT  read --pr "$PR" --gate doc  $CP_FLAG --expect FAIL 2>/dev/null)" && DOC_FAIL=1  || DOC_FAIL=0

# UNRESOLVED ≠ "no FAIL". The verb prints its outcome JSON on BOTH exit paths, so absent JSON means the
# namespace never resolved (a transport/5xx failure). Reading that as "no repair in flight" would file
# a twin defect against a live repair — so treat it as UNKNOWN and defer this invocation.
VERDICT_UNKNOWN=0
for J in "$CODE_FAIL_JSON" "$DOC_FAIL_JSON"; do jq -e . >/dev/null 2>&1 <<<"$J" || VERDICT_UNKNOWN=1; done

# the native decisive review folds into the code namespace (the verb reads only marker comments), by
# NEWEST-WRITTEN wins — the same fold ship-it Step 2 / write-code R1 run. `at: .submitted_at` is what
# the compare reads (a review is never upserted, so it IS the review's write time); a bare
# "CHANGES_REQUESTED ⇒ CODE_FAIL=1" would report a repair in flight on a PR whose newer marker already
# PASS'd at the same head, suppressing a defect that should be filed.
CURRENT_HEAD="$(gh api repos/$REPO/pulls/$PR --jq .head.sha)"
REVIEW=$(gh api "repos/$REPO/pulls/$PR/reviews?per_page=100" \
  --jq '[.[] | select(.state=="APPROVED" or .state=="CHANGES_REQUESTED")]
        | sort_by(.submitted_at) | last | {state, sha: .commit_id, at: .submitted_at}')
RSTATE=$(jq -r '.state // ""' <<<"$REVIEW"); RSHA=$(jq -r '.sha // empty' <<<"$REVIEW")
RAT=$(jq -r '.at // ""' <<<"$REVIEW")
# `_tag == "current"` is exactly "a current-head marker verdict stands"; the verb's `writtenAt` is the
# WRITE time the compare needs — never the comment's created_at, which an in-place upsert leaves at the
# slot's open time and which would let a review wrongly out-rank a later-written marker (#4200).
MARKER_AT=""
[ "$(jq -r '._tag // ""' <<<"$CODE_FAIL_JSON" 2>/dev/null)" = "current" ] &&
  MARKER_AT=$(jq -r '.writtenAt // empty' <<<"$CODE_FAIL_JSON" 2>/dev/null)
if [ -n "$RSHA" ] && [ -n "$RAT" ]; then case "$CURRENT_HEAD" in "$RSHA"*)
  # ISO-8601-UTC sorts lexically, so `>` IS the chronological compare.
  if [ -z "$MARKER_AT" ] || [ "$RAT" \> "$MARKER_AT" ]; then
    [ "$RSTATE" = "CHANGES_REQUESTED" ] && CODE_FAIL=1 || CODE_FAIL=0
  fi
;; esac; fi

# the N=3 repair cap `verdict read` does NOT count: a PR already at 3 FAIL rounds is escalated to a
# human, NOT an active repair. The script author-gates the FAIL markers to write+ collaborators
# (ADR 0055) and clusters by >120s gap — the same round identity write-code uses. A non-zero exit is
# UNKNOWN, never 0 rounds; read the status before the number.
ROUNDS="$("$HERE/repair-rounds.sh" "$PR")" || {
	printf '%s\n' "$ROUNDS" >&2
	echo "heal-ci: the FAIL-round count did not resolve — UNKNOWN, never 0 rounds. No answer emitted." >&2
	exit 1
}

printf 'VERDICT_UNKNOWN=%s\nCODE_FAIL=%s\nDOC_FAIL=%s\nROUNDS=%s\n' \
	"$VERDICT_UNKNOWN" "$CODE_FAIL" "$DOC_FAIL" "$ROUNDS"
