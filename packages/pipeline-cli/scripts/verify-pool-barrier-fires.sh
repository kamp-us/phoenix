#!/usr/bin/env bash
# Mutation proof for the write-code pool barrier (#4693): each mutant must make a NAMED test red.
#
# A guard you cannot demonstrate failing is not demonstrated. This plants three counterexamples in a
# throwaway copy of `src/tools/epic-ledger/`, runs the suite against the copy, and asserts the mutant
# died for its INTENDED reason — the specific test title has to appear in a FAIL line, not merely
# "something went red". A harness that scores any redness as a kill passes even when its mutants are
# dying of a typo.
#
# Nothing under `src/tools/epic-ledger/` is ever edited: the mutants live in a copy, so there is no
# restore step whose failure could leave a sabotaged validator in the working tree.
#
# usage: bash packages/pipeline-cli/scripts/verify-pool-barrier-fires.sh
# shellcheck disable=SC1007,SC2016
set -uo pipefail

HERE="$(CDPATH= cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [ -z "$HERE" ] || [ ! -d "$HERE/src/tools/epic-ledger" ]; then
	echo "FAIL: could not resolve packages/pipeline-cli from this script's own location — refusing to run against nothing (ADR 0092)"
	exit 1
fi

SRC="$HERE/src/tools/epic-ledger"
RUN="$HERE/src/__mutation__"
# vitest's include is `src/**/*.test.ts`, so the copy has to live under src/ to be collected at all.
REL="src/__mutation__/epic-ledger"

# One row per mutant, TAB-separated: <label> <file> <find> <replace> <test title that MUST go red>.
# The find/replace are LITERAL — the planter is a string splice, not a regex, so an anchor reads
# exactly as it does in the source.
MUTANTS=(
	"$(printf 'M1 an unread assignee slot laundered into an empty one\tgithub.ts\tassignees?.map((a) => a.login)\t(assignees ?? []).map((a) => a.login)\tan absent or null `assignees` key decodes to UNOBSERVED, never to unassigned')"
	"$(printf 'M2 the held-child barrier check disabled\tvalidate.ts\t} else if (child.labels.includes(HELD_FOR_HUMAN_LABEL) && child.assignees.length === 0) {\t} else if (false) {\tmutant 1 — drop the assignee: HELD_CHILD_UNASSIGNED, and nothing else')"
	"$(printf 'M3 the unverifiable-slot check disabled\tvalidate.ts\tif (child.assignees === undefined) {\tif (child.assignees === undefined && Array.isArray(child.assignees)) {\tmutant 3 — unobserve the slot on an agent-audience child: still UNVERIFIABLE, never a skip')"
)

if [ "${#MUTANTS[@]}" -eq 0 ]; then
	echo "FAIL: zero mutants — a proof that plants nothing proves nothing (ADR 0092)"
	exit 1
fi

# Literal splice, in node so no shell metacharacter survives into an anchor. Exit 3 means the anchor
# is not in the file any more, which is a drifted proof rather than a surviving mutant.
splice() { # <file> <find> <replace>
	node -e '
		const fs = require("node:fs");
		const [file, find, replace] = process.argv.slice(1);
		const before = fs.readFileSync(file, "utf8");
		if (!before.includes(find)) process.exit(3);
		fs.writeFileSync(file, before.split(find).join(replace));
	' "$1" "$2" "$3"
}

stage() {
	rm -rf "$RUN"
	mkdir -p "$RUN" || return 1
	cp -R "$SRC" "$RUN/epic-ledger" || return 1
}

run_suite() {
	(cd "$HERE" && npx vitest run "$REL" 2>&1)
}

FAILURES=0
CHECKS=0

echo "== baseline: the unmutated copy must be GREEN =="
CHECKS=$((CHECKS + 1))
if ! stage; then
	echo "FAIL: could not stage the baseline copy"
	exit 1
fi
BASE_OUT="$(run_suite)"
BASE_STATUS=$?
if [ "$BASE_STATUS" -ne 0 ]; then
	echo "FAIL: the unmutated copy is already red, so no mutant death below is attributable"
	echo "$BASE_OUT" | tail -20
	FAILURES=$((FAILURES + 1))
else
	echo "ok — baseline green, so every death below is attributable to its mutant"
fi

for row in "${MUTANTS[@]-}"; do
	CHECKS=$((CHECKS + 1))
	label="$(printf '%s' "$row" | cut -f1)"
	file="$(printf '%s' "$row" | cut -f2)"
	find="$(printf '%s' "$row" | cut -f3)"
	replace="$(printf '%s' "$row" | cut -f4)"
	expect="$(printf '%s' "$row" | cut -f5)"
	echo
	echo "== $label =="

	if ! stage; then
		echo "FAIL: could not stage a copy for $label"
		FAILURES=$((FAILURES + 1))
		continue
	fi
	splice "$RUN/epic-ledger/$file" "$find" "$replace"
	SPLICE_STATUS=$?
	case "$SPLICE_STATUS" in
		0) ;;
		3)
			echo "FAIL: the anchor for $label is no longer in $file — the proof has drifted, so a green run would be meaningless"
			FAILURES=$((FAILURES + 1))
			continue
			;;
		*)
			echo "FAIL: could not plant $label"
			FAILURES=$((FAILURES + 1))
			continue
			;;
	esac

	OUT="$(run_suite)"
	OUT_STATUS=$?
	if [ "$OUT_STATUS" -eq 0 ]; then
		echo "FAIL: $label SURVIVED — the guard did not fire on its own counterexample"
		FAILURES=$((FAILURES + 1))
		continue
	fi
	if printf '%s\n' "$OUT" | grep -F "FAIL" | grep -qF "$expect"; then
		echo "ok — died for its intended reason: \"$expect\""
	else
		echo "FAIL: $label went red, but NOT on \"$expect\" — a mutant that dies of something else is not evidence"
		printf '%s\n' "$OUT" | grep -F "FAIL" | head -10
		FAILURES=$((FAILURES + 1))
	fi
done

rm -rf "$RUN"

echo
if [ "$FAILURES" -ne 0 ]; then
	echo "POOL-BARRIER MUTATION PROOF: FAIL ($FAILURES of $CHECKS checks)"
	exit 1
fi
echo "POOL-BARRIER MUTATION PROOF: PASS (${#MUTANTS[@]} mutants, each red on its own named test; baseline green)"
