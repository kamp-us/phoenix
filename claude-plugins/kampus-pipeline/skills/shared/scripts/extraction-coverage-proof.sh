#!/usr/bin/env bash
# THE ZERO-COVERAGE-DELTA PROOF for epic #4435's extractions, as a runnable harness rather than a table
# in a PR body. Extraction moves content out of one scan surface and into another; a guard that follows
# the markdown but not the `.sh` stays GREEN while guarding nothing (#4470, and the two rows PR #4492
# had to correct from "preserved" to "narrowed"). A table asserting the delta cannot be re-run at the
# next SHA. This can.
#
# usage: extraction-coverage-proof.sh <moved-file...>
#
# It proves TWO different things, and they are not interchangeable:
#   1. SCOPE — each guard actually admits every handed `.sh` into its scanned surface, read off the
#      guard's own emitted scope line rather than inferred from a clean exit. A clean exit over zero
#      scanned files is the false green this harness exists to catch.
#   2. TEETH — each guard REDS on planted bait in a `.sh`, so "clean" is a finding about the files and
#      not about the matcher. A row that cannot be made to fail is not a guard.
#
# The bait strings are ASSEMBLED AT RUN TIME from fragments, never written as literals: a literal
# user-home path or a literal bare CLI token in this file would be a real finding in the very corpus the
# guards scan, and papering over it with a `DOC_SELF_EXEMPT` entry would weaken the guard to test it
# (the trap PR #4503 fell into, #4517). No exemption is needed, and none is requested.
#
# `set -uo pipefail` without `-e`, and NO `EXIT` trap: every probe's exit status is the datum, `errexit`
# would abort on the first (expected) red, and on bash 3.2 a `set -u` abort reaching an `EXIT` trap
# yields exit **0** — a fail-closed harness exiting clean having printed its FAIL (#4476, class #4479).
set -uo pipefail

[ "$#" -ge 1 ] || {
	echo "extraction-coverage-proof: no files handed — ZERO SCOPE, which is a failure and NOT a zero-delta proof (§ZS / ADR 0092)."
	echo "usage: extraction-coverage-proof.sh <moved-file...>" >&2
	exit 2
}

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "extraction-coverage-proof: not inside a git repository — NOTHING was proven."; exit 1; }
PCLI="$ROOT/claude-plugins/kampus-pipeline/bin/pipeline-cli"
[ -x "$PCLI" ] || { echo "extraction-coverage-proof: the CLI shim is not executable at the in-repo path — NOTHING was proven (UNKNOWN, never 'clean')."; exit 1; }

WORK="$(mktemp -d)" || { echo "extraction-coverage-proof: could not create a work dir — NOTHING was proven."; exit 1; }
FAILS=0

# Every probe below runs the guard UNPIPED and reads its raw exit status. Never through a pipe or
# `xargs`, both of which remap the status these rows rest on (the #4485 lesson).
#
# assert_rc <label> <expected-rc> -- <cmd...>: exact status match.
assert_rc() {
	label="$1"
	want="$2"
	shift 2
	[ "$1" = "--" ] && shift
	"$@" >"$WORK/out" 2>"$WORK/err"
	got=$?
	if [ "$got" = "$want" ]; then
		printf 'ok    %-58s rc=%s\n' "$label" "$got"
	else
		printf 'FAIL  %-58s rc=%s (want %s)\n' "$label" "$got" "$want"
		FAILS=$((FAILS + 1))
	fi
}

# assert_red <label> <needle> -- <cmd...>: non-zero exit AND the named violation on the output. Both
# halves are required, because these guards ALSO fail closed on a per-surface zero scope (exit 3) — so a
# bare "non-zero" would pass a teeth row that never looked at the bait at all. That is why every teeth
# probe below hands the bait TOGETHER WITH a real corpus `.md`: it keeps every surface non-empty, so the
# only thing left that can red the run is the bait.
assert_red() {
	label="$1"
	needle="$2"
	shift 2
	[ "$1" = "--" ] && shift
	"$@" >"$WORK/out" 2>"$WORK/err"
	got=$?
	if [ "$got" -ne 0 ] && grep -q -- "$needle" "$WORK/out" "$WORK/err"; then
		printf 'ok    %-58s rc=%s, reported: %s\n' "$label" "$got" "$needle"
	else
		printf 'FAIL  %-58s rc=%s, did NOT report: %s\n' "$label" "$got" "$needle"
		FAILS=$((FAILS + 1))
	fi
}

# assert_scope <label> <needle> -- <cmd...>: the guard's own emitted scope line must contain <needle>.
# This is the row that catches a NARROWED surface: a guard can exit clean while its scope line says it
# scanned zero of the files it was handed.
assert_scope() {
	label="$1"
	needle="$2"
	shift 2
	[ "$1" = "--" ] && shift
	"$@" >"$WORK/out" 2>"$WORK/err"
	if grep -q -- "$needle" "$WORK/out" "$WORK/err"; then
		printf 'ok    %-58s scope contains: %s\n' "$label" "$needle"
	else
		printf 'FAIL  %-58s scope does NOT contain: %s\n' "$label" "$needle"
		FAILS=$((FAILS + 1))
	fi
}

SH_COUNT=0
MD_COUNT=0
COMPANION_MD=""
for f in "$@"; do
	[ -f "$f" ] || { echo "extraction-coverage-proof: '$f' does not exist — the handed set is wrong, so NOTHING is proven."; rm -rf "$WORK"; exit 1; }
	case "$f" in
		*.sh) SH_COUNT=$((SH_COUNT + 1)) ;;
		*.md)
			MD_COUNT=$((MD_COUNT + 1))
			[ -n "$COMPANION_MD" ] || COMPANION_MD="$f"
			;;
	esac
done
[ "$SH_COUNT" -gt 0 ] || { echo "extraction-coverage-proof: not one .sh among the handed files — there is no extracted surface to prove coverage over."; rm -rf "$WORK"; exit 1; }
[ -n "$COMPANION_MD" ] || { echo "extraction-coverage-proof: no .md among the handed files — the teeth probes need one to keep the markdown surface non-empty, so NOTHING is proven."; rm -rf "$WORK"; exit 1; }
printf 'handed: %d file(s) — %d .sh, %d .md (teeth companion: %s)\n\n' "$#" "$SH_COUNT" "$MD_COUNT" "$COMPANION_MD"

echo '--- 1. SCOPE: every handed .sh enters each guard'"'"'s scanned surface ---'
assert_scope "leak-guard: .sh is a scanned surface" "$SH_COUNT shell surface" -- "$PCLI" leak-guard scan "$@"
assert_scope "cli-invocation-guard: .sh is an implicit fence" "$SH_COUNT shell file(s) as implicit fences" -- "$PCLI" cli-invocation-guard check "$@"
assert_scope "gh-phoenix lint-skills: .sh in the gh-call scan" "gh-call scan scanned $# file(s)" -- "$PCLI" gh-phoenix lint-skills "$@"

echo
echo '--- 2. TEETH: each guard REDS on planted bait in a .sh ---'
# A user-home absolute path, assembled so this file carries no such literal.
BAIT_HOME="$WORK/bait-home.sh"
{
	printf '#!/usr/bin/env bash\n'
	printf 'X=/%s/%s/code/thing\n' Users someone
} >"$BAIT_HOME"
assert_red "leak-guard reds a home path in a .sh" "bait-home.sh" -- "$PCLI" leak-guard scan "$BAIT_HOME" "$COMPANION_MD"

# A bare CLI invocation, token assembled from fragments for the same reason.
CLI_TOKEN="pipeline""-cli"
BAIT_CLI="$WORK/bait-cli.sh"
{
	printf '#!/usr/bin/env bash\n'
	printf '%s tracker create-issue\n' "$CLI_TOKEN"
} >"$BAIT_CLI"
assert_red "cli-invocation-guard reds a bare CLI call in a .sh" "bait-cli.sh" -- "$PCLI" cli-invocation-guard check "$BAIT_CLI" "$COMPANION_MD"

BAIT_GQL="$WORK/bait-graphql.sh"
{
	printf '#!/usr/bin/env bash\n'
	printf 'gh api %s -f query=%s\n' graphql '"{viewer{login}}"'
} >"$BAIT_GQL"
assert_red "lint-skills reds a GraphQL gh call in a .sh" "bait-graphql.sh" -- "$PCLI" gh-phoenix lint-skills "$BAIT_GQL" "$COMPANION_MD"

echo
echo '--- 3. The handed files themselves are clean on every surface above ---'
assert_rc "leak-guard clean over the handed set" 0 -- "$PCLI" leak-guard scan "$@"
assert_rc "cli-invocation-guard clean over the handed set" 0 -- "$PCLI" cli-invocation-guard check "$@"
assert_rc "lint-skills clean over the handed set" 0 -- "$PCLI" gh-phoenix lint-skills "$@"

rm -rf "$WORK"
echo
printf 'violations: %d\n' "$FAILS"
[ "$FAILS" -eq 0 ] || { echo "extraction-coverage-proof: FAILED — at least one guard neither scans the extracted surface nor reds on it."; exit 1; }
echo "extraction-coverage-proof: OK — every guard admits the extracted .sh into its surface AND reds on planted bait there."
