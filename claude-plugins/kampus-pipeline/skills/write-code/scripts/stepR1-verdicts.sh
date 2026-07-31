#!/usr/bin/env bash
# Step R1: resolve the latest current-head verdict per namespace, and build the write+ author set the
# two downstream repair steps reuse.
#
# usage: stepR1-verdicts.sh <PR>
#
# stdout is five `KEY=value` lines — `REPAIR_SCRATCH=`, `VERDICT_UNKNOWN=`, `CODE_FAIL=`, `DOC_FAIL=`,
# `SKILL_FAIL=`. A namespace is repairable iff its flag is 1. `VERDICT_UNKNOWN=1` means a namespace
# never resolved at all (a transport/5xx failure, not a verdict): DEFER the run, never read it as
# "nothing to repair" — a deferred repair is retried, a skipped one is lost.
#
# The ADR-0058 SHA-bound resolution — the write+ author-gate (ADR 0055), the latest-wins pick, and
# the staleness refusal — is owned by `pipeline-cli verdict read` and delegated to below, never
# re-derived here (#2102 / #3254). The author set this script *does* build is a separate artifact:
# two downstream steps that are more than a single (PR, gate) resolution reuse it.
#
# Executed, never sourced (ADR 0232). The R1 fence used to leave `$comments_file`, `$authorized` and
# the three `*_FAIL_JSON` payloads in the agent's shell for Bounding, R2 and the inline-comment fold
# to read. Shell state does not cross an agent's Bash calls, so that state moves to the §SP per-run
# scratch namespace, whose directory this prints as `REPAIR_SCRATCH=`; stepR-round-count.sh,
# stepR2-inline-comments.sh and stepR2-fail-body.sh re-derive the same path and read it there. Each
# refuses if R1 never wrote it — an absent set is UNKNOWN, never an empty one.
# shellcheck disable=SC1007,SC1091,SC2016,SC2086
set -uo pipefail
# shellcheck source=../../../lib/common.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

PR="${1:-}"
if [ -z "$PR" ]; then
	printf 'write-code Step R1: no PR number — run this as `bash ./claude-plugins/kampus-pipeline/skills/write-code/scripts/stepR1-verdicts.sh <PR>`. NO verdict was resolved (UNKNOWN, never "nothing to repair").\n' >&2
	exit 1
fi
REPO="$(kp_repo)" || { echo "write-code Step R1: target repo unresolved — NO verdict was resolved (UNKNOWN, never 'nothing to repair')." >&2; exit 1; }
# GATE-CRITICAL (§CLI): an unresolved CLI would print no outcome JSON, which the UNKNOWN test below
# already defers on — refuse up front anyway, so the reason is legible instead of inferred. Exit 127
# means the CLI never ran; that is UNKNOWN, never "nothing to repair" (ADR 0207).
PCLI="$(kp_pcli)" || exit 127
if [ -z "${CLAUDE_CODE_SESSION_ID:-}" ]; then
	echo "write-code Step R1: §SP session id unset — refusing to write repair state through a shared path (#3718)." >&2
	exit 1
fi
SCRATCH="${TMPDIR:-/tmp}/kampus-run/$CLAUDE_CODE_SESSION_ID/write-code-repair-$PR"
mkdir -p "$SCRATCH" || { echo "write-code Step R1: §SP could not create a per-run scratch dir (#3718)." >&2; exit 1; }

# The write+ author-set (ADR 0055) — `verdict read` computes it internally for the marker resolution,
# but two DOWNSTREAM steps that are genuinely more than a single (PR, gate) resolution reuse it: the
# inline-review-comment gate (Step R2) and the repair-mode N=3 FAIL-round count. Build it once here.
gh api "repos/$REPO/issues/$PR/comments?per_page=100" > "$SCRATCH/comments.json" \
	|| { echo "write-code Step R1: could not read the PR comment stream — the author set is UNKNOWN, never empty." >&2; exit 1; }
markerAuthors=$(jq -r '[.[]
    | select(.body | test("^\\s*\\**\\s*review-(code|doc|skill):\\s*(PASS|FAIL)"; "i"))
    | .user.login] | unique | .[]' "$SCRATCH/comments.json")
authorized='[]'
while IFS= read -r a; do
	[ -z "$a" ] && continue
	perm=$(gh api "repos/$REPO/collaborators/$a/permission" --jq .permission 2>/dev/null)
	case "$perm" in
		admin|maintain|write) authorized=$(jq -c --arg a "$a" '. + [$a]' <<<"$authorized") ;;
	esac
done <<<"$markerAuthors"
printf '%s\n' "$authorized" > "$SCRATCH/authorized.json"

# §CP-ness is part of the (PR, gate, head, §CP-ness) tuple `verdict read` resolves (#4049) — see the
# Step-1 pre-pick scan for the full why, including why the file list comes from `cp_changed_files`
# instead of a fail-OPEN `gh … | cp-classify` pipe.
# shellcheck source=../../shared/scripts/cp-read.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/scripts" && pwd)/cp-read.sh"
# `>&2` routes only the §ZS scope LINE, not the result: the file list arrives in $CP_FILES, and THIS
# script's stdout is the five-line answer its caller reads, so a diagnostic on it would corrupt that.
if ! cp_changed_files "$REPO" "$PR" >&2; then
	CP_STATE=unknown   # the input never arrived ⇒ UNKNOWN ⇒ hold as §CP (never `not-control-plane`)
else
	CP_STATE="$(printf '%s\n' "$CP_FILES" | "$PCLI" cp-classify classify --repo "$REPO" 2>/dev/null)"
fi
if [ "$CP_STATE" = "not-control-plane" ]; then CP_FLAG=""; else CP_FLAG="--cp"; fi

# a namespace is a repairable FAIL iff its latest authorized verdict is FAIL bound to the current head
# — exit 0 from `verdict read … --expect FAIL`. The verb's JSON (stdout) carries the resolving comment
# id, which Step R2 uses to read the FAIL body. A stale / SHA-less / PASS / none verdict exits non-zero,
# so it is correctly NOT repaired (idempotent no-op), needing no separate staleness test here.
CODE_FAIL_JSON="$("$PCLI" verdict read --pr "$PR" --gate code  $CP_FLAG --expect FAIL 2>/dev/null)"  && CODE_FAIL=1  || CODE_FAIL=0
DOC_FAIL_JSON="$("$PCLI"  verdict read --pr "$PR" --gate doc   $CP_FLAG --expect FAIL 2>/dev/null)"  && DOC_FAIL=1   || DOC_FAIL=0
SKILL_FAIL_JSON="$("$PCLI" verdict read --pr "$PR" --gate skill $CP_FLAG --expect FAIL 2>/dev/null)" && SKILL_FAIL=1 || SKILL_FAIL=0
printf '%s' "$CODE_FAIL_JSON"  > "$SCRATCH/code-fail.json"
printf '%s' "$DOC_FAIL_JSON"   > "$SCRATCH/doc-fail.json"
printf '%s' "$SKILL_FAIL_JSON" > "$SCRATCH/skill-fail.json"

# UNRESOLVED ≠ "no FAIL". `verdict read` prints its outcome JSON on BOTH exit paths, so absent JSON
# means the namespace never resolved at all (a transport/5xx error, not a verdict). Under a flaky
# GitHub that silently reads as "nothing to repair" and SKIPS a real repair — so treat it as UNKNOWN
# and defer the run instead (a deferred repair is retried; a skipped one is lost).
VERDICT_UNKNOWN=0
for J in "$CODE_FAIL_JSON" "$DOC_FAIL_JSON" "$SKILL_FAIL_JSON"; do
	jq -e . >/dev/null 2>&1 <<<"$J" || VERDICT_UNKNOWN=1
done

# the native decisive review folds into the code namespace (the verb reads only marker comments):
# GitHub author-attributes reviews, so this path needs no ACL gate — commit_id IS its bound SHA, and
# only a review prefix-matching the current head participates (ADR 0058).
#
# The fold is NEWEST-WRITTEN wins — the resolution ship-it Step 2 states and this step mirrors.
# `at: .submitted_at` is load-bearing, not decoration: it is what the compare reads, and a review is
# never upserted, so `submitted_at` IS the review's write time — like for like against the marker's
# `writtenAt` below. A bare
# "CHANGES_REQUESTED ⇒ CODE_FAIL=1" would be FAIL-precedence, re-entering repair on a PR whose newer
# marker already PASS'd at the same head — a spurious repair loop, not a safe default.
CURRENT_HEAD="$(gh api repos/$REPO/pulls/$PR --jq .head.sha)"
REVIEW=$(gh api "repos/$REPO/pulls/$PR/reviews?per_page=100" \
	--jq '[.[] | select(.state=="APPROVED" or .state=="CHANGES_REQUESTED")]
        | sort_by(.submitted_at) | last | {state, sha: .commit_id, at: .submitted_at}')
RSTATE=$(jq -r '.state // ""' <<<"$REVIEW"); RSHA=$(jq -r '.sha // empty' <<<"$REVIEW")
RAT=$(jq -r '.at // ""' <<<"$REVIEW")
# marker side: `_tag == "current"` is exactly "a current-head marker verdict stands" (a none/sha-less/
# stale one does not participate); the verb's `writtenAt` is the WRITE time newest-wins compares
# against — never the comment's created_at, which an in-place upsert leaves behind (#4200).
MARKER_AT=""
[ "$(jq -r '._tag // ""' <<<"$CODE_FAIL_JSON" 2>/dev/null)" = "current" ] &&
	MARKER_AT=$(jq -r '.writtenAt // empty' <<<"$CODE_FAIL_JSON" 2>/dev/null)
if [ -n "$RSHA" ] && [ -n "$RAT" ]; then case "$CURRENT_HEAD" in "$RSHA"*)
	# ISO-8601-UTC sorts lexically, so `>` IS the chronological compare. Empty MARKER_AT ⇒ the review is
	# the only current-head event ⇒ it decides alone. A newer APPROVED clears an older FAIL — that is the
	# point: without it a repaired-and-re-approved PR would re-enter repair forever.
	if [ -z "$MARKER_AT" ] || [ "$RAT" \> "$MARKER_AT" ]; then
		[ "$RSTATE" = "CHANGES_REQUESTED" ] && CODE_FAIL=1 || CODE_FAIL=0
	fi
;; esac; fi

printf 'REPAIR_SCRATCH=%s\nVERDICT_UNKNOWN=%s\nCODE_FAIL=%s\nDOC_FAIL=%s\nSKILL_FAIL=%s\n' \
	"$SCRATCH" "$VERDICT_UNKNOWN" "$CODE_FAIL" "$DOC_FAIL" "$SKILL_FAIL"
