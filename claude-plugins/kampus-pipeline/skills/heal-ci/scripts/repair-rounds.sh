#!/usr/bin/env bash
# The N=3 FAIL-round count that `pipeline-cli verdict read` does NOT do — it resolves the latest
# verdict, it does not count rounds. A PR already at 3 FAIL rounds is escalated to a human, NOT an
# active repair, so the twin-suppression guard counts the rounds itself.
#
# usage: repair-rounds.sh <pr>
#
# Prints the round count on stdout. Author-gated to write+ collaborators (ADR 0055) so a forged
# `review-*: FAIL` cannot inflate it, and clustered by >120s gap — the same round identity write-code
# uses (a both-namespace round counts once).
#
# FAIL-CLOSED: the caller reads `ROUNDS < 3` as "not escalated", which is the branch that can SUPPRESS
# a defect filing. A count that could not be read must therefore never arrive as 0 — it exits non-zero
# with its own line on stdout, and the prose reads the status before the number (§ZS / ADR 0092). An
# empty authorized set legitimately counts zero rounds; that is fail-closed in the other direction
# (zero rounds means "not capped", so the guard falls through to filing rather than suppressing).
#
# Extracted from heal-ci/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "heal-ci: repair-rounds.sh needs a PR number — the round count did NOT run (UNKNOWN, never 0)."; echo "usage: repair-rounds.sh <pr>" >&2; exit 2; }
PR="$1"
REPO="$(kp_repo)" || { echo "heal-ci: target repo unresolved — the round count did NOT run (UNKNOWN, never 0)."; exit 1; }

comments_file=$(mktemp)
gh api "repos/$REPO/issues/$PR/comments?per_page=100" > "$comments_file" || {
	rm -f "$comments_file"
	echo "heal-ci: could not read PR #$PR's comments — the FAIL-round count is UNKNOWN, never 0."
	exit 1
}
markerAuthors=$(jq -r '[.[]
    | select(.body | test("^\\s*\\**\\s*review-(code|doc):\\s*(PASS|FAIL)"; "i"))
    | .user.login] | unique | .[]' "$comments_file")
authorized='[]'
while IFS= read -r a; do
	[ -z "$a" ] && continue
	perm=$(gh api "repos/$REPO/collaborators/$a/permission" --jq .permission 2>/dev/null)
	case "$perm" in
		admin | maintain | write) authorized=$(jq -c --arg a "$a" '. + [$a]' <<<"$authorized") ;;
	esac
done <<<"$markerAuthors"
ROUNDS=$(jq --argjson authorized "$authorized" \
	'[.[] | select(.user.login | IN($authorized[]))
        | select(.body | test("^\\s*\\**\\s*review-(code|doc):\\s*FAIL"; "i"))
        | .created_at | sub("\\..*Z$";"Z") | fromdateiso8601]
   | sort
   | reduce .[] as $t ({n:0, prev:null};
       if (.prev == null) or ($t - .prev) > 120
       then {n:(.n+1), prev:$t} else {n:.n, prev:$t} end)
   | .n' "$comments_file")
rm -f "$comments_file"
[ -n "$ROUNDS" ] || { echo "heal-ci: the FAIL-round reduction produced no count — UNKNOWN, never 0."; exit 1; }

printf '%s\n' "$ROUNDS"
