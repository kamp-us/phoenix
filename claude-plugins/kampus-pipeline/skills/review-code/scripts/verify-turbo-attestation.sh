#!/usr/bin/env bash
# Re-derive #4887's claim instead of asserting it: the gate's turbo-driven checks are attested as
# really having executed, and a replay is refused rather than read as a pass.
#
# usage: bash ./claude-plugins/kampus-pipeline/skills/review-code/scripts/verify-turbo-attestation.sh [<pr>]
#
# Leg 1 (always, no review worktree needed) exercises the judgement against three fixture summaries:
# all-executed, one-replayed, and zero-task. Leg 2 (only when a PR is given, i.e. when a reviewer has
# already materialized that PR's head) runs the gate's own typecheck path TWICE against the same
# tree and requires BOTH runs to attest `verdict=RAN` — the second run is where an unforced
# invocation would have gone FULL TURBO.
#
# stdout is prose: every check names itself and its outcome, so "it ran and found nothing" is never
# an empty stdout. Any failure exits non-zero.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

# shellcheck disable=SC1007
HERE="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
FAILED=0

fixtures="$(mktemp -d)" || {
	echo "verify-turbo-attestation: could not create a fixture directory — cannot verify." >&2
	exit 1
}

cat >"$fixtures/all-executed.json" <<'EOF'
{
  "turboVersion": "2.10.3",
  "tasks": [
    {"taskId": "@kampus/a#typecheck", "cache": {"status": "MISS"}},
    {"taskId": "@kampus/b#typecheck", "cache": {"status": "MISS"}}
  ]
}
EOF
cat >"$fixtures/one-replayed.json" <<'EOF'
{
  "turboVersion": "2.10.3",
  "tasks": [
    {"taskId": "@kampus/a#typecheck", "cache": {"status": "MISS"}},
    {"taskId": "@kampus/b#typecheck", "cache": {"status": "HIT"}}
  ]
}
EOF
cat >"$fixtures/zero-tasks.json" <<'EOF'
{"turboVersion": "2.10.3", "tasks": []}
EOF

check() { # <label> <expected-exit> <expected-substring-or-empty> <fixture>
	local label="$1" want_rc="$2" want_text="$3" fixture="$4" out rc
	out="$(node "$HERE/attest-turbo-summary.mjs" "$fixtures/$fixture" typecheck 2>/dev/null)"
	rc=$?
	if [ "$rc" -ne "$want_rc" ]; then
		printf 'FAIL %s — exit %s, expected %s\n' "$label" "$rc" "$want_rc"
		FAILED=1
		return
	fi
	case "$want_text" in
		'')
			if [ -n "$out" ]; then
				printf 'FAIL %s — expected empty stdout, got: %s\n' "$label" "$out"
				FAILED=1
				return
			fi
			;;
		*)
			case "$out" in
				*"$want_text"*) ;;
				*)
					printf 'FAIL %s — stdout lacks %s: %s\n' "$label" "$want_text" "$out"
					FAILED=1
					return
					;;
			esac
			;;
	esac
	printf 'PASS %s\n' "$label"
}

check "all tasks executed -> attested RAN" 0 "verdict=RAN" all-executed.json
check "all tasks executed -> counts every task as executed" 0 "executed=2 replayed=0" all-executed.json
check "one task replayed -> refused as REPLAYED" 4 "verdict=REPLAYED" one-replayed.json
check "one task replayed -> names the replayed task" 4 "replayed-tasks=@kampus/b#typecheck:HIT" one-replayed.json
check "zero tasks -> zero scope, no attestation on stdout" 3 "" zero-tasks.json

rm -rf "$fixtures"

if [ "$#" -lt 1 ]; then
	printf 'SKIP live leg — no PR given, so no materialized head to run the gate path against. Pass a PR whose head this session materialized to run it.\n'
else
	PR="$1"
	for attempt in 1 2; do
		out="$(bash "$HERE/worktree-typecheck.sh" "$PR" 2>/dev/null)"
		rc=$?
		case "$out" in
			*"verdict=RAN"*)
				if [ "$rc" -eq 0 ]; then
					printf 'PASS live run %s of 2 against the same tree — %s\n' "$attempt" "$out"
				else
					printf 'FAIL live run %s of 2 — attested RAN but exited %s\n' "$attempt" "$rc"
					FAILED=1
				fi
				;;
			*)
				printf 'FAIL live run %s of 2 — no RAN attestation on stdout (exit %s): %s\n' "$attempt" "$rc" "$out"
				FAILED=1
				;;
		esac
	done
fi

[ "$FAILED" -eq 0 ] || { printf 'verify-turbo-attestation: FAILED\n'; exit 1; }
printf 'verify-turbo-attestation: all checks passed\n'
