#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091
# Reviewer-runnable proof for `splice-body.sh`'s round-trip check (#4596), driving the REAL script
# against a stubbed `gh` — never a re-implementation of its awk, which would be blind to exactly the
# defect it is here to pin (the expected side was derived from a surface that is never stored).
#
# Four cases, and the negative ones are the point: a check that only proves the happy path has
# replaced a false alarm with a silent miss, which is strictly worse.
#
#   A. CLEAN, deps-last, `deps.md` carrying the instructed trailing blank line → exit 0, "round-tripped".
#      This is the #4596 false positive: it FAILS on the pre-fix script.
#   B. CLOBBERED topology — the stored body's block gains a child line → exit 1, racer verdict.
#   C. CLOBBERED whitespace INSIDE the block — trailing spaces on a content line → exit 1. The
#      normalization is trailing-blank-LINES only; anything inside the block stays byte-exact.
#   D. CLOBBERED heading-adjacent blank — an interior blank line deleted → exit 1. Pins that the
#      normalization did not degrade into "strip all blank lines".
#
# B/C/D are the anti-weakening clamp. Falsify this harness by deleting the `deps_block` normalization
# from splice-body.sh: A must go red. Falsify it the other way by widening `deps_block` to strip all
# whitespace: C and D must go red.
#
# Hermetic: `gh` is stubbed on PATH, so this needs no auth and touches no live issue. The
# `pipeline-cli` shim IS the real one — `epic-splice apply` and `scratchpad` are offline local
# transforms, and stubbing them would take the transform under test out of the loop.
#
# usage: bash claude-plugins/kampus-pipeline/skills/plan-epic/scripts/verify-roundtrip-diff.sh
#
# Shell shape per .patterns/skill-script-shell-shape.md: `set -uo pipefail`, never `-e`, and no
# `EXIT` trap — on bash 3.2 `-e` plus a cleanup trap launders a `set -u` abort into exit 0, and this
# harness's whole contract is its exit status.
set -uo pipefail
# shellcheck source=../../../lib/common.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
UNDER_TEST="$DIR/splice-body.sh"
[ -f "$UNDER_TEST" ] || { echo "FAIL: zero scope — no splice-body.sh at $UNDER_TEST (ADR 0092)"; exit 1; }

# A number no live epic uses: the stub `gh` is the only thing that ever answers for it, and the
# scratch namespace it keys is this harness's own.
EPIC=999000
export CLAUDE_PIPELINE_REPO="kampus-verify/roundtrip"
# The harness must be runnable outside an agent session (CI has no session id), and §SP keys the
# scratch namespace on it. A per-process fallback keeps the namespace this run's own.
export CLAUDE_CODE_SESSION_ID="${CLAUDE_CODE_SESSION_ID:-verify-roundtrip-$$}"

TMP="$(mktemp -d)"
if [ -z "$TMP" ] || [ ! -d "$TMP" ]; then
	echo "FAIL: mktemp -d produced no temp root — refusing to run against nothing (ADR 0092)"
	exit 1
fi
BIN="$TMP/bin"
mkdir -p "$BIN" || { echo "FAIL: cannot create the stub dir under $TMP"; exit 1; }

# The stub server. `body` is the stored body, byte-for-byte what the PATCH handed it — modelling
# GitHub as a verbatim store on purpose, so case A's mismatch can only come from the CLIENT-side
# `$(cat)` strip and not from a normalization this harness invented. $CLOBBER, when set, is a sed
# program applied to the stored body right after the write: that IS the racer.
cat > "$BIN/gh" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
BODY_F="$GH_STATE/body"
AT_F="$GH_STATE/updated-at"
patch=0
val=""
for a in "$@"; do
	case "$a" in
	PATCH) patch=1 ;;
	body=*) val="${a#body=}" ;;
	esac
done
if [ "$patch" = 1 ]; then
	printf '%s' "$val" > "$BODY_F"
	if [ -n "${CLOBBER:-}" ]; then
		sed "$CLOBBER" "$BODY_F" > "$BODY_F.new" && mv "$BODY_F.new" "$BODY_F"
	fi
	printf '{"ok":true}\n'
	exit 0
fi
for a in "$@"; do
	case "$a" in
	'.body') jq -rn --rawfile b "$BODY_F" '$b'; exit 0 ;;
	'{body,updated_at}') jq -n --rawfile b "$BODY_F" --arg u "$(cat "$AT_F")" '{body:$b,updated_at:$u}'; exit 0 ;;
	esac
done
jq -n --rawfile b "$BODY_F" --arg u "$(cat "$AT_F")" '{body:$b,updated_at:$u}'
STUB
chmod +x "$BIN/gh"

BASE_BODY='## Brief

A worked epic body whose LAST section is the dependency topology — the standard
first-time-plan layout, because a first-time plan APPENDS the block to EOF.

## Plan (plan-epic)

### Phase 1

- build the thing
'
# The trailing blank line is the one SKILL.md instructs ("Give each block a trailing blank line so
# the next spliced heading stays separated"). It is what the pre-fix round-trip choked on.
DEPS_BLOCK='## Dependencies

### Phase 1: #900001, #900002

- #900001 — first child
- #900002 — second child (requires: #900001)

'

fail=0
run_case() {   # $1 = case name, $2 = expected exit (0|1), $3 = sed clobber program (may be empty)
	local name="$1" want="$2" clobber="$3" scratch rc out
	scratch="$(kp_scratch_open "plan-epic-$EPIC")" || { echo "BAD   $name: could not open the scratch namespace"; fail=1; return; }
	mkdir -p "$TMP/state" || { echo "BAD   $name: could not create the stub state dir"; fail=1; return; }
	printf '%s' "$BASE_BODY" > "$TMP/state/body"
	printf '%s' "2026-07-31T00:00:00Z" > "$TMP/state/updated-at"
	printf '%s' "$BASE_BODY" > "$scratch/current.md"
	printf '%s' "2026-07-31T00:00:00Z" > "$scratch/updated-at.txt"
	printf '%s' "$DEPS_BLOCK" > "$scratch/deps.md"
	# The freshness guard compares mtimes; back-date the base rather than sleeping, so the guard is
	# satisfied deterministically instead of by however coarse this filesystem's clock is.
	touch -t 202001010000 "$scratch/current.md" "$scratch/updated-at.txt"
	out="$(PATH="$BIN:$PATH" GH_STATE="$TMP/state" CLOBBER="$clobber" bash "$UNDER_TEST" "$EPIC" 2>&1)"
	rc=$?
	if [ "$rc" = "$want" ]; then
		printf 'OK    %-34s exit=%s (want %s)\n' "$name" "$rc" "$want"
	else
		printf 'BAD   %-34s exit=%s (want %s)\n' "$name" "$rc" "$want"
		printf '%s\n' "$out" | sed 's/^/      /'
		fail=1
	fi
	printf '%s' "$out" > "$TMP/last-out"
}

echo "scope: $UNDER_TEST driven against a stubbed gh, 4 cases"

run_case "A clean deps-last round-trip" 0 ""
grep -q 'round-tripped' "$TMP/last-out" || { echo "BAD   A: exit 0 without the landed verdict on stdout"; fail=1; }

run_case "B clobbered topology" 1 's/second child/second child AND A THIRD/'
grep -q 'a racer clobbered it' "$TMP/last-out" || { echo "BAD   B: exit 1 without the racer verdict on stdout"; fail=1; }

run_case "C trailing spaces on a content line" 1 's/first child$/first child   /'
grep -q 'a racer clobbered it' "$TMP/last-out" || { echo "BAD   C: exit 1 without the racer verdict on stdout"; fail=1; }

run_case "D interior blank line whitespaced" 1 's/^$/ /'
grep -q 'a racer clobbered it' "$TMP/last-out" || { echo "BAD   D: exit 1 without the racer verdict on stdout"; fail=1; }

rm -rf "$TMP"
if [ "$fail" -ne 0 ]; then
	echo "FAIL: splice-body.sh's round-trip check does not hold both directions (#4596)"
	exit 1
fi
echo "PASS: a clean deps-last splice round-trips, and every in-block difference still reds (#4596)"
