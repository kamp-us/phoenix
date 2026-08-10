#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC2016
# SC2016 is declared, not waved off: every sed program below matches LITERAL shell text inside
# common.sh (`$CLAUDE_CODE_SESSION_ID`, `$KP_LANE_BEAT_TTL`), so expanding it here would match nothing
# and the mutant would be a no-op that "passes" — the exact failure this harness exists to catch.
#
# Reviewer-runnable proof that the lane-lifecycle cases in common-test.sh are FALSIFIABLE (#4868).
#
# The bug being fixed was a check whose positive branch could never be false, and a suite can carry
# that same defect: cases that pass whether or not the discriminator discriminates. So each mutant
# below reintroduces one specific blindness into a COPY of the lib, and this harness requires the
# suite to go red FOR ITS OWN NAMED REASON — the exact assertion text, not merely a non-zero exit.
# A mutant that dies for an unrelated reason proves nothing about the case it was aimed at.
#
# Usage:  bash claude-plugins/kampus-pipeline/lib/verify-lane-lifecycle-mutants.sh
#
# Shell shape per .patterns/skill-script-shell-shape.md: `set -uo pipefail`, never `-e`, no EXIT trap
# — on bash 3.2 `-e` plus a cleanup trap launders a `set -u` abort into exit 0, and this harness's
# whole contract is its exit status.
set -uo pipefail

LIB="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
fail=0

for f in common.sh common-test.sh; do
	if [ ! -f "$LIB/$f" ]; then
		echo "FAIL: zero scope — $LIB/$f does not exist, so nothing was mutated (ADR 0092)"
		exit 1
	fi
done

TMP="$(mktemp -d)"
if [ -z "$TMP" ] || [ ! -d "$TMP" ]; then
	echo "FAIL: mktemp -d produced no temp root — refusing to run against nothing (ADR 0092)"
	exit 1
fi

# BASELINE first. If the unmutated suite is red, every mutant below is red too and the whole harness
# would report a false green on "the mutant died".
if ! bash "$LIB/common-test.sh" > "$TMP/baseline.log" 2>&1; then
	echo "FAIL: the UNMUTATED suite is already red — no mutation result below would mean anything:"
	sed -n 's/^FAIL: /  baseline FAIL: /p' "$TMP/baseline.log"
	rm -rf "$TMP"
	exit 1
fi
echo "ok: baseline — the unmutated suite is green, so a red below is attributable to the mutation"

# <name> <expected-failure-substring> <sed-program…> — patch a COPY of the lib, run the suite against
# it, and require BOTH a non-zero exit AND the named assertion. `mutate` never touches $LIB.
mutate() {
	local name="$1" want="$2" n=0 rc
	shift 2
	local dir="$TMP/m$RANDOM$$"
	mkdir -p "$dir" || {
		echo "FAIL: [$name] could not create the mutant dir"
		fail=1
		return
	}
	cp "$LIB/common.sh" "$LIB/common-test.sh" "$dir/" || {
		echo "FAIL: [$name] could not copy the lib"
		fail=1
		return
	}
	for prog in "$@"; do
		if ! sed "$prog" "$dir/common.sh" > "$dir/common.sh.new"; then
			echo "FAIL: [$name] sed program did not apply: $prog"
			fail=1
			return
		fi
		if ! mv "$dir/common.sh.new" "$dir/common.sh"; then
			echo "FAIL: [$name] could not install the mutated lib"
			fail=1
			return
		fi
		n=$((n + 1))
	done
	# A mutant identical to the original is a no-op that would "pass" every assertion below by
	# accident. Refuse it: this is the same zero-scope floor the guards themselves keep (ADR 0092).
	if cmp -s "$dir/common.sh" "$LIB/common.sh"; then
		echo "FAIL: [$name] the $n sed program(s) changed NOTHING — the mutation never happened, so its death proves nothing"
		fail=1
		return
	fi
	bash "$dir/common-test.sh" > "$dir/out.log" 2>&1
	rc=$?
	if [ "$rc" -eq 0 ]; then
		echo "FAIL: [$name] the mutant SURVIVED — the suite is green with the blindness reintroduced, so it does not test for it"
		fail=1
	elif ! grep -qF "$want" "$dir/out.log"; then
		echo "FAIL: [$name] the mutant died for the WRONG reason — expected an assertion naming [$want], got:"
		sed -n 's/^FAIL: /    /p' "$dir/out.log"
		fail=1
	else
		echo "ok: [$name] mutant died for its intended reason — $(grep -F "$want" "$dir/out.log" | head -1 | cut -c1-120)…"
	fi
}

# M1 — THE ORIGINAL DEFECT, put back verbatim: decide `live-lane` from the session id alone, with no
# beat consulted. Every same-session tree then reads live-lane forever, exactly as shipped.
mutate 'M1 identity-only live-lane (the #4868 defect)' \
	'the positive branch is still unfalsifiable (#4868 AC2)' \
	's|if \[ -n "\$age" \] \&\& \[ "\$age" -lt "\$ttl" \]; then|if [ -n "${CLAUDE_CODE_SESSION_ID:-}" ]; then|'

# M2 — keep the beat, drop the PROOF: treat every dormant tree as safe to release. The dormant state
# stops being a real guard and becomes a slower way to fail open.
mutate 'M2 quiescence proof always true' \
	'a dormant lane'"'"'s DIRTY tree was released' \
	's|^kp_lane_quiescent() { #|kp_lane_quiescent() { return 0; # MUTANT: everything below is dead #|'

# M3 — break the lane-FINISH half: retiring becomes a no-op that reports success. The routine
# finished-lane case silently stays stuck, and a caller that trusts the return value never knows.
mutate 'M3 retire is a no-op' \
	'the stamp was not retired by rename' \
	's|^kp_lane_retire() { #|kp_lane_retire() { return 0; # MUTANT: everything below is dead #|'

# M4 — treat an UNREADABLE beat as "beating right now". Absent evidence read as the permissive
# answer is the §ZS violation this whole class keeps reproducing.
mutate 'M4 missing beat reads as fresh' \
	'must read dormant-lane, not live-lane' \
	's|age="\$(kp_lane_beat_age "\$admin")"|age="0" # MUTANT: unknown age is not 0|'

rm -rf "$TMP"
if [ "$fail" -ne 0 ]; then
	echo "verify-lane-lifecycle-mutants: FAILED"
	exit 1
fi
echo "verify-lane-lifecycle-mutants: all mutants died for their intended reasons"
