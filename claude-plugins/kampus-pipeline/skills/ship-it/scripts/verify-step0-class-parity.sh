#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC2016
# SC2016 is declared, not waved off: the mutant generators' sed programs are LITERAL shell text —
# expanding their `$CLASS_OUT` / `$` here would rewrite the mutants into something else.
# Reviewer-runnable proof that ship-it Step 0's printed class set EQUALS `class-probe classify`'s —
# the property #4730 found false, where the step printed a strict SUBSET and nothing noticed.
#
# The fixture is the load-bearing part. The old divergence was invisible to any test whose diff
# classified as *something*, because the failure mode was SILENCE on an unclassified file and silence
# subtracts a class — a smaller answer is still well-formed, still exit 0. So case 1 below is a diff
# containing files that classify as NOTHING under the three §CLASS predicates (a plugin home's
# `README.md` + `docs/**`, beside its `skills/**`): not under a code root, not under a
# `skills/`|`agents/` segment, and carved out of the doc test. That is PR #4724's exact shape, and
# any plugin home carrying docs beside its skills reproduces it. Case 2 is a diff where every file
# classifies, so a harness that passed both would still be distinguishing something real.
#
# Falsifiability is asserted, not assumed (#4744). The harness generates three MUTANTS of the step,
# each breaking the parity this file exists to pin, and requires the compare to go red under each —
# and to go red for the RIGHT reason, which is why each mutant asserts on the printed class sets and
# not merely on a non-zero exit:
#   M1  the subtractive copy returns — `has-code` is dropped from the emitted set, reproducing #4730
#       on case 1: the step prints `has-skills` where the probe prints `has-code has-skills`
#   M2  a SUPERSET instead of a subtraction — `has-ui` is appended unconditionally, so the compare is
#       pinned in both directions rather than as a one-way subset test
#   M3  the step emits NO class set at all (the probe call is stubbed empty, so Step 0 takes its
#       no-class STOP path) — an unrun step must read as disagreement, never as agreement-by-silence
#
# ZERO SCOPE IS A FAILURE, NOT A PASS (ADR 0092). The cases and mutants below are counted as they
# run, and the final verdict refuses unless both counts equal the declared totals — so a case or a
# mutant deleted, renamed, or aborted mid-run reds here instead of printing a vacuous `OK` over an
# empty scope. The count is the scope statement, not the sentence at the bottom.
#
# Hermetic: `gh` is stubbed to serve the fixture as the PR's changed-file list, so this needs no auth
# and touches no repo state. `pipeline-cli` is REAL — the point is to compare the shipped verb's
# answer against the step's, and a stubbed probe would compare a stub to itself.
#
# Usage:  bash claude-plugins/kampus-pipeline/skills/ship-it/scripts/verify-step0-class-parity.sh
#         CI runs the same script from that path (ci.yml, the `skills` job).
#
# Shell shape per .patterns/skill-script-shell-shape.md: `set -uo pipefail`, never `-e`, and no
# `EXIT` trap — on bash 3.2 `-e` plus a cleanup trap launders a `set -u` abort into exit 0, and this
# harness's whole contract is its exit status.
set -uo pipefail

# PHYSICAL resolution (`cd -P` / `pwd -P`): the step under test resolves its own sourced chain
# through `../../../lib`. Reached through any symlinked or relative caller and left logical, that hop
# folds textually against the caller's path instead of the real one and lands where no `lib/` exists
# — the step then dies at its source line and prints no class set, which this harness would score as
# a caught disagreement while testing nothing. Resolving here physically is what keeps the `..` hops
# real whatever path the caller used.
DIR="$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd -P)"
SUT="$DIR/step0-classify.sh"
if [ ! -f "$SUT" ]; then
	echo "FAIL: zero scope — $SUT does not exist, so there is no Step 0 to compare against (ADR 0092)"
	exit 1
fi

ROOT="$(git -C "$DIR" rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$ROOT" ]; then
	echo "FAIL: could not resolve the repo root from $DIR — refusing to verify against nothing (ADR 0092)"
	exit 1
fi
PLUGIN="$ROOT/claude-plugins/kampus-pipeline"
PCLI="$PLUGIN/bin/pipeline-cli"
if [ ! -x "$PCLI" ]; then
	echo "FAIL: the CLI shim is missing or not executable at claude-plugins/kampus-pipeline/bin/pipeline-cli — restore it (chmod +x); without it the parity compare has no reference answer"
	exit 1
fi

TMP="$(mktemp -d)"
if [ -z "$TMP" ] || [ ! -d "$TMP" ]; then
	echo "FAIL: mktemp -d produced no temp root — refusing to run against nothing (ADR 0092)"
	exit 1
fi
BIN="$TMP/bin"
mkdir -p "$BIN" || { echo "FAIL: cannot create the stub dir under $TMP"; exit 1; }

# The hermetic `gh`: serve $FIXTURE for the changed-files endpoint and the REAL working-tree bytes
# for the two `contents/` reads a §CLASS/UI re-resolution would make, an empty success otherwise.
# Serving those two for real is what keeps this harness able to fail: a step that re-derived the
# class set would resolve the genuine boundary regexes and print its genuine (smaller) answer, rather
# than falling back to the `.`-matches-everything sentinel an empty stub would hand it — which
# over-dispatches and would mask the very subtraction under test. Both paths travel in the
# environment because the stub is a separate process.
cat > "$BIN/gh" <<'STUB'
#!/usr/bin/env bash
for a in "$@"; do
  case "$a" in
    */pulls/*/files*) cat "$FIXTURE"; exit 0 ;;
    *contents/*gh-issue-intake-formats.md*) cat "$FORMATS_SRC"; exit 0 ;;
    *contents/*ship-it/SKILL.md*) cat "$SHIPIT_SRC"; exit 0 ;;
  esac
done
exit 0
STUB
chmod +x "$BIN/gh" || { echo "FAIL: cannot chmod the gh stub"; exit 1; }

FORMATS_SRC="$PLUGIN/skills/gh-issue-intake-formats.md"
SHIPIT_SRC="$PLUGIN/skills/ship-it/SKILL.md"
for f in "$FORMATS_SRC" "$SHIPIT_SRC"; do
	if [ ! -f "$f" ]; then
		echo "FAIL: $f is missing — the stub cannot serve the boundary sources, so a subtractive step would be masked by fail-closed sentinels"
		exit 1
	fi
done
export FORMATS_SRC SHIPIT_SRC

fail=0
CASES_RUN=0
MUTANTS_RUN=0
EXPECTED_CASES=2
EXPECTED_MUTANTS=3

# Run one step script over one fixture and print the class words it emitted, `<empty>` when it
# emitted none. `<empty>` is a distinct token on purpose: a step that STOPPED and a step that printed
# a smaller set are different defects, and a blank field in the failure text hides which one fired.
step_classes() {   # $1 = step script, $2 = fixture
	out="$(PATH="$BIN:$PATH" FIXTURE="$2" bash "$1" kamp-us/phoenix 4724 2>/dev/null \
		| grep -E '^(has-code|has-docs|has-skills|has-ui)$' || true)"
	printf '%s' "$out"
}

fmt() {   # newline-joined class set → one space-joined line, `<empty>` when there is none
	if [ -z "$1" ]; then printf '<empty>'; else printf '%s' "$1" | tr '\n' ' '; fi
}

# The compare, shared by the real cases and the mutants: the two answers come from different
# processes reading the same input, which is what makes it able to fail. Prints one verdict line and
# returns 0 iff parity holds AND the agreed set is the expected one.
compare() {   # $1 = step script, $2 = name, $3 = fixture, $4 = expected class words (newline-joined)
	got_step="$(step_classes "$1" "$3")"
	got_probe="$("$PCLI" class-probe classify --files-from "$3" --root "$ROOT" 2>/dev/null || true)"
	if [ -z "$got_probe" ]; then
		printf 'BAD   %-34s the reference probe produced NO class set — the compare would be vacuous\n' "$2"
		return 1
	fi
	if [ "$got_step" != "$got_probe" ]; then
		printf 'BAD   %-34s step 0 and class-probe DISAGREE\n  step0:       %s\n  class-probe: %s\n' \
			"$2" "$(fmt "$got_step")" "$(fmt "$got_probe")"
		return 1
	fi
	if [ "$got_step" != "$4" ]; then
		printf 'BAD   %-34s parity holds but the set is not the expected one\n  got:      %s\n  expected: %s\n' \
			"$2" "$(fmt "$got_step")" "$(fmt "$4")"
		return 1
	fi
	printf 'ok    %-34s %s\n' "$2" "$(fmt "$got_step")"
	return 0
}

check() {   # $1 = name, $2 = expected class words — run against the REAL step
	CASES_RUN=$((CASES_RUN + 1))
	compare "$SUT" "$1" "$FIXTURE" "$2" || fail=1
}

# 1. THE REGRESSION CASE — plugin docs beside plugin skills. The first two files classify as NOTHING
#    under the §CLASS predicates and ride has-code only because `class-probe` folds the #2765
#    no-class rule in. A step that derived its own answer printed `has-skills` alone here.
FIXTURE="$TMP/plugin-docs.txt"
cat > "$FIXTURE" <<'FILES'
claude-plugins/fabrika/README.md
claude-plugins/fabrika/docs/authoring-brief-contract.md
claude-plugins/fabrika/docs/cli-interface-convention.md
claude-plugins/fabrika/skills/adr/SKILL.md
FILES
REGRESSION_FIXTURE="$FIXTURE"
check "plugin docs beside skills (#4730)" "$(printf 'has-code\nhas-skills')"

# 2. THE CONTROL — every file classifies on its own, so this case passed even BEFORE the fix. Keeping
#    it is what shows case 1 is discriminating rather than the harness being green on everything.
FIXTURE="$TMP/classified.txt"
cat > "$FIXTURE" <<'FILES'
packages/pipeline-cli/src/tools/verdict/command.ts
.patterns/index.md
FILES
check "every file classifies (control)" "$(printf 'has-code\nhas-docs')"

# --- falsifiability: the compare must go red under a step that breaks parity -----------------------
#
# A mutant must live at the SAME depth as the original: the step resolves its shared lib through
# `../../../lib` and cp-read through `../../shared/scripts`, so a mutant dropped in a flat temp dir
# would die at its own source lines and print no class set — which reads as a disagreement and would
# score the mutant caught for entirely the wrong reason. Hence a mirrored tree whose `lib`, `bin` and
# `skills/shared` are symlinks back to the real plugin, and hence every mutant asserts on the class
# sets in the failure text rather than on a bare non-zero exit.
MUT="$TMP/mut"
mkdir -p "$MUT/skills/ship-it/scripts" || { echo "FAIL: cannot create the mutant tree under $TMP"; exit 1; }
ln -s "$PLUGIN/lib" "$MUT/lib" || { echo "FAIL: cannot link the plugin lib into the mutant tree"; exit 1; }
ln -s "$PLUGIN/bin" "$MUT/bin" || { echo "FAIL: cannot link the plugin bin into the mutant tree"; exit 1; }
ln -s "$PLUGIN/skills/shared" "$MUT/skills/shared" || { echo "FAIL: cannot link skills/shared into the mutant tree"; exit 1; }
MUTANT="$MUT/skills/ship-it/scripts/step0-classify.sh"

mutate() {   # $1 = name, $2… = sed programs applied in order
	name="$1"; shift
	cp "$SUT" "$MUTANT" || { printf 'BAD   %-34s cannot copy the step into the mutant tree\n' "$name"; fail=1; return 1; }
	for prog in "$@"; do
		sed "$prog" "$MUTANT" > "$MUTANT.tmp" && mv "$MUTANT.tmp" "$MUTANT"
	done
	if cmp -s "$SUT" "$MUTANT"; then
		printf 'BAD   %-34s the mutant is byte-identical to the original — it reverts nothing\n' "$name"
		fail=1
		return 1
	fi
	return 0
}

# A mutant is caught only when the compare goes red AND its failure text names the class sets the
# mutation was meant to produce. Asserting on the exit status alone would score a mutant that died of
# a broken source line — the #4700 lesson — as a mutant the parity check caught.
expect_mutant() {   # $1 = name, $2 = fixture, $3… = substrings the failure text MUST carry
	name="$1"; fx="$2"; shift 2
	MUTANTS_RUN=$((MUTANTS_RUN + 1))
	out="$(compare "$MUTANT" "$name" "$fx" "$(printf 'has-code\nhas-skills')" 2>&1)"
	rc=$?
	if [ "$rc" -eq 0 ]; then
		printf 'BAD   %-34s the compare stayed GREEN under a mutant that breaks parity\n' "$name"
		fail=1
		return
	fi
	for want in "$@"; do
		case "$out" in
			*"$want"*) : ;;
			*)
				printf 'BAD   %-34s the compare went red for the WRONG reason — expected the text to carry %s, got: %s\n' \
					"$name" "$want" "$out"
				fail=1
				return
				;;
		esac
	done
	printf 'ok    %-34s mutant caught (%s)\n' "$name" "$(printf '%s' "$out" | head -1 | sed 's/^BAD  *//')"
}

# M1 — the subtractive copy returns: `has-code` never reaches stdout, exactly #4730's shape.
if mutate "M1 has-code subtracted" 's|^printf .%s\\n. "\$CLASS_OUT"$|printf "%s\\n" "$CLASS_OUT" \| grep -v "^has-code$"|'; then
	expect_mutant "M1 has-code subtracted" "$REGRESSION_FIXTURE" "DISAGREE" "step0:       has-skills" "class-probe: has-code has-skills"
fi

# M2 — a SUPERSET, not a subtraction: the compare is an equality, so an ADDED class must red too.
if mutate "M2 has-ui added" 's|^printf .%s\\n. "\$CLASS_OUT"$|printf "%s\\n" "$CLASS_OUT"; echo has-ui|'; then
	expect_mutant "M2 has-ui added" "$REGRESSION_FIXTURE" "DISAGREE" "step0:       has-code has-skills has-ui" "class-probe: has-code has-skills"
fi

# M3 — the step prints NO class set (its own no-class STOP path). Agreement-by-silence is the exact
# reading this harness must never make, so the `<empty>` token is asserted rather than a blank field.
if mutate "M3 step emits nothing" 's|^CLASS_OUT="\$(printf .*$|CLASS_OUT=""|'; then
	expect_mutant "M3 step emits nothing" "$REGRESSION_FIXTURE" "DISAGREE" "step0:       <empty>" "class-probe: has-code has-skills"
fi

# ZERO-SCOPE FAIL-CLOSED (ADR 0092): the counters are the scope statement. A deleted case, a mutant
# whose generator aborted, or a `check` that never ran leaves a count short — and a short count is
# never a pass, because "nothing disagreed" over an empty scope is the vacuous green this whole file
# exists to make impossible.
if [ "$CASES_RUN" -ne "$EXPECTED_CASES" ] || [ "$MUTANTS_RUN" -ne "$EXPECTED_MUTANTS" ]; then
	printf 'FAIL: zero/short scope — ran %s of %s parity case(s) and %s of %s mutant(s); refusing to report a verdict over a scope that is not the declared one (ADR 0092)\n' \
		"$CASES_RUN" "$EXPECTED_CASES" "$MUTANTS_RUN" "$EXPECTED_MUTANTS"
	exit 1
fi

if [ "$fail" -ne 0 ]; then
	echo "verify-step0-class-parity: FAILED — Step 0's class set is not class-probe's (#4730)"
	exit 1
fi
printf 'verify-step0-class-parity: OK — %s parity case(s) + %s mutant(s); Step 0 prints class-probe answer, including on a diff whose files classify as nothing\n' \
	"$CASES_RUN" "$MUTANTS_RUN"
