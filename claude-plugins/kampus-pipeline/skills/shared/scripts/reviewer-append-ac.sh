#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2086
# Perform the ADR-0079 reviewer AC append with all four §2 fences enforced at this site.
#
# usage: reviewer-append-ac.sh <ISSUE> <PR> <ROUND_K> <GATE> "<criterion>" "<finding>"
#   ISSUE     the issue whose `### Acceptance criteria` list the row lands on (for review-plan,
#             the CHILD issue — that gate has no PR)
#   PR        the PR number the provenance tag records (for review-plan, the child again)
#   ROUND_K   the §5/Bounding round-cluster index for THIS PR; 1-based, a first review is round 1
#   GATE      the appending gate's namespace — one of review-code / review-doc / review-skill /
#             review-plan, the four call sites `../specialist-fan-out.md` names
#   criterion the AC row text (observable, checkable from the outside)
#   finding   the in-scope defect, named in the fence-4 escalation comment
#
# Three outcomes, each announced by an `APPEND-STATE:` token on stdout, all exit 0 — the gate is
# never blocked by this step, it still posts its normal verdict:
#   skipped-below-write-floor   fence 3 refused (not write+, or the ACL lookup failed)
#   escalated-frozen-round-K    fence 4 froze the append and escalated to a human
#   appended                    the one new row was written back
# Exit 1 is the fence-1 abort (a pre-existing line would change) or an input/repo resolution that
# could not be produced: nothing on stdout, a named diagnostic on stderr (ADR 0232, #4510).
#
# Extracted from `../specialist-fan-out.md`'s "Performing the append" fenced block (#4566, epic
# #4435). The four fences are RELAYED, not re-derived (ADR 0228/0229): every decision below is the
# one the fence made, at the same exit status. The *why* — what each fence is and why it exists —
# stays in that file's prose and in `../gh-issue-intake-formats.md` §2, which is the single source.
set -uo pipefail
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

if [ "$#" -ne 6 ]; then
	echo "reviewer-append-ac: needs 6 arguments — NO append and NO escalation happened." >&2
	echo "usage: reviewer-append-ac.sh <ISSUE> <PR> <ROUND_K> <GATE> \"<criterion>\" \"<finding>\"" >&2
	exit 2
fi
ISSUE="$1"
PR="$2"
ROUND_K="$3"
GATE="$4"
CRITERION="$5"
FINDING="$6"

# Argument shape is checked before any fence runs: the fence-4 branch is `[ "$ROUND_K" -ge 3 ]`, and
# a non-numeric ROUND_K makes `test` error out to a FALSE, which would slide a frozen round into the
# append path. Refusing here keeps that branch's fail-closed direction intact.
for _n in "$ISSUE" "$PR" "$ROUND_K"; do
	case "$_n" in
		(''|*[!0-9]*)
			echo "reviewer-append-ac: ISSUE/PR/ROUND_K must be numbers, got '$_n' — NO append and NO escalation happened." >&2
			exit 2
			;;
	esac
done
# The gate namespace is an argument because one script serves the four call sites that cite the
# reference; the tag it composes is §2's, per-gate.
case "$GATE" in
	(review-code|review-doc|review-skill|review-plan) : ;;
	(*)
		echo "reviewer-append-ac: GATE must be review-code|review-doc|review-skill|review-plan, got '$GATE' — NO append and NO escalation happened." >&2
		exit 2
		;;
esac
REPO="$(kp_repo)" || {
	echo "reviewer-append-ac: target repo unresolved — NO append and NO escalation happened." >&2
	exit 1
}
echo "reviewer-append-ac scope: repo $REPO · issue #$ISSUE · pr #$PR · round $ROUND_K · gate $GATE"

# the §2 in-scope-only fence (fence 2) gates whether you may append AT ALL:
# only an in-scope finding (traces to the issue's stated goal — Route, don't grade above)
# reaches here. A finding that fails the trace test was already routed to `report`; it must
# NOT arrive at this append step. If it did, route it to `report` and stop — never append it.

# ── Fence 3: ACL-gated, FAILS CLOSED ──────────────────────────────────────────────────────
# resolve your OWN authority at the GitHub ACL — the same write+ floor ADR 0055 applies to
# verdict-marker authority — BEFORE writing anything. No checked-in allowlist; the repo ACL is
# the trust root. Any non-write+/lookup-failure result fails closed: skip the append, route the
# finding to `report` instead (the PR is not blocked — it still gets your normal verdict).
ME="$(gh api user --jq .login)"
PERM="$(gh api "repos/$REPO/collaborators/$ME/permission" --jq .permission 2>/dev/null)"
case "$PERM" in
	(admin|maintain|write) : ;;                      # authorized — proceed
	(*)
		echo "below write+ floor (or ACL lookup failed) — fail closed: do NOT append, route to report"
		echo "APPEND-STATE: skipped-below-write-floor"
		exit 0
		;;
esac

# ── Fence 4: frozen-after-round-K (K = N = 3) ─────────────────────────────────────────────
# the round K this append would be tagged with arrives as an argument — the §5/Bounding
# round-cluster index for THIS PR (the same count write-code's cap uses). An append in/after the
# final repair round has no round left to drain-and-re-verify it within the bound, so it
# ESCALATES to a human instead of appending-and-looping (the append-side of write-code's
# drain-side freeze — §2 fence 4).
if [ "$ROUND_K" -ge 3 ]; then
	# frozen: append-rate must not outrun fix-rate. Escalate, never append — name the finding,
	# hand the PR to a human, surface for re-triage (mirrors write-code's N=3 escalation path).
	# The heredoc is composed through a FILE, not inline in `$(cat <<EOF … EOF)` as the reference's
	# block wrote it: on bash 3.2 that inline form silently truncates this body at the `)` of
	# "(accept as-is, …, or drop it)" and appends a literal `EOF )` — measured, not theorised. Same
	# authored text, a parse the interpreter can actually deliver.
	ESC_FILE="$(mktemp)"
	if [ -z "$ESC_FILE" ] || [ ! -f "$ESC_FILE" ]; then
		echo "reviewer-append-ac: mktemp produced no file — NO escalation comment was posted, NO label applied." >&2
		exit 1
	fi
	cat > "$ESC_FILE" <<EOF
### Append escalation — in-scope finding raised at/after the final repair round (round $ROUND_K)

A reviewer specialist surfaced an in-scope finding, but it arrives in/after \`write-code\`'s
final repair round (K = N = 3), so there is no round left to drain-and-re-verify a fresh AC
within the bound. Per ADR 0079 §2 fence 4 the append is **frozen** — escalating to a human
instead of appending-and-looping:

- $FINDING

Needs a human decision (accept as-is, extend the AC's life by a fresh triage, or drop it).
EOF
	ESCALATION="$(cat "$ESC_FILE")"
	rm -f "$ESC_FILE"
	gh api repos/$REPO/issues/$ISSUE/comments -f body="$ESCALATION" >/dev/null
	gh api -X POST repos/$REPO/issues/$ISSUE/labels -f "labels[]=status:needs-triage" >/dev/null
	echo "APPEND-STATE: escalated-frozen-round-$ROUND_K"
	exit 0   # frozen → escalated, NOT appended
fi

# ── Fence 1: append-only — add the one new row, never edit/remove a pre-existing one ───────
# read the CURRENT body, append exactly one §2-shaped row (provenance-tagged), write it back.
# Reconstructing the body this way makes removal/edit unrepresentable: every pre-existing line
# is carried through byte-for-byte; only a trailing criterion is added.
BODY="$(gh api repos/$REPO/issues/$ISSUE --jq .body)"
NEW_AC="- [ ] $CRITERION <!-- ac:$GATE pr:#$PR round:$ROUND_K -->"
# The insertion point is the naive one the reference's block carried (marked `# illustrative`
# there): the row lands at the END of the body, not under the `### Acceptance criteria` heading.
# Making it heading-aware is new behaviour, not this conversion's to invent — fence 1 holds either
# way, since every prior line survives verbatim.
UPDATED="$(printf '%s\n%s\n' "$BODY" "$NEW_AC")"
# fail-closed integrity guard: refuse to write back a body that DROPPED or ALTERED any prior
# line — append-only means every prior line survives verbatim in the new body. If a pre-existing
# line would change, abort (never write a body that lost a criterion — the gate-weakening
# catastrophe fence 1 forbids). The diff is captured BEFORE it is matched on purpose: with
# `pipefail` on, `diff … | grep -qE '^< '` returns diff's own 1-on-difference even when grep
# matched, so the guard's `&&` would never fire and the abort would be silently disabled.
# Its over-strictness on a body with no trailing newline is preserved as-is — see #4600.
DIFF_OUT="$(diff <(printf '%s' "$BODY") <(printf '%s' "$UPDATED"))"
if printf '%s\n' "$DIFF_OUT" | grep -qE '^< '; then
	echo "append-only violation: a pre-existing line would change — ABORT, do not write" >&2
	exit 1
fi
gh api -X PATCH repos/$REPO/issues/$ISSUE -f body="$UPDATED" >/dev/null
echo "APPEND-STATE: appended"
