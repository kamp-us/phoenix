#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007
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
# Hermetic: `gh` is stubbed to serve the fixture as the PR's changed-file list, so this needs no auth
# and touches no repo state. `pipeline-cli` is REAL — the point is to compare the shipped verb's
# answer against the step's, and a stubbed probe would compare a stub to itself.
#
# Usage:  bash claude-plugins/kampus-pipeline/skills/ship-it/scripts/verify-step0-class-parity.sh
#
# Shell shape per .patterns/skill-script-shell-shape.md: `set -uo pipefail`, never `-e`, and no
# `EXIT` trap — on bash 3.2 `-e` plus a cleanup trap launders a `set -u` abort into exit 0, and this
# harness's whole contract is its exit status.
set -uo pipefail

DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT="$(git -C "$DIR" rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$ROOT" ]; then
	echo "FAIL: could not resolve the repo root from $DIR — refusing to verify against nothing (ADR 0092)"
	exit 1
fi
PCLI="$ROOT/claude-plugins/kampus-pipeline/bin/pipeline-cli"
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

FORMATS_SRC="$ROOT/claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md"
SHIPIT_SRC="$ROOT/claude-plugins/kampus-pipeline/skills/ship-it/SKILL.md"
for f in "$FORMATS_SRC" "$SHIPIT_SRC"; do
	if [ ! -f "$f" ]; then
		echo "FAIL: $f is missing — the stub cannot serve the boundary sources, so a subtractive step would be masked by fail-closed sentinels"
		exit 1
	fi
done
export FORMATS_SRC SHIPIT_SRC

fail=0

# One case: write the fixture, run the step under the stub, and compare its class words against the
# real probe's answer over the identical list. The two answers come from different processes reading
# the same input — that is what makes the compare able to fail.
check() {   # $1=name, $2=expected class words (newline-joined, in probe emission order)
	name="$1"; expected="$2"
	got_step="$(PATH="$BIN:$PATH" FIXTURE="$FIXTURE" bash "$DIR/step0-classify.sh" kamp-us/phoenix 4724 2>/dev/null \
		| grep -E '^(has-code|has-docs|has-skills|has-ui)$' || true)"
	got_probe="$("$PCLI" class-probe classify --files-from "$FIXTURE" --root "$ROOT" 2>/dev/null || true)"
	if [ -z "$got_probe" ]; then
		printf 'BAD   %-34s the reference probe produced NO class set — the compare would be vacuous\n' "$name"
		fail=1
		return
	fi
	if [ "$got_step" != "$got_probe" ]; then
		printf 'BAD   %-34s step 0 and class-probe DISAGREE\n  step0:      %s\n  class-probe: %s\n' \
			"$name" "$(printf '%s' "$got_step" | tr '\n' ' ')" "$(printf '%s' "$got_probe" | tr '\n' ' ')"
		fail=1
		return
	fi
	if [ "$got_step" != "$expected" ]; then
		printf 'BAD   %-34s parity holds but the set is not the expected one\n  got:      %s\n  expected: %s\n' \
			"$name" "$(printf '%s' "$got_step" | tr '\n' ' ')" "$(printf '%s' "$expected" | tr '\n' ' ')"
		fail=1
		return
	fi
	printf 'ok    %-34s %s\n' "$name" "$(printf '%s' "$got_step" | tr '\n' ' ')"
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
check "plugin docs beside skills (#4730)" "$(printf 'has-code\nhas-skills')"

# 2. THE CONTROL — every file classifies on its own, so this case passed even BEFORE the fix. Keeping
#    it is what shows case 1 is discriminating rather than the harness being green on everything.
FIXTURE="$TMP/classified.txt"
cat > "$FIXTURE" <<'FILES'
packages/pipeline-cli/src/tools/verdict/command.ts
.patterns/index.md
FILES
check "every file classifies (control)" "$(printf 'has-code\nhas-docs')"

if [ "$fail" -ne 0 ]; then
	echo "verify-step0-class-parity: FAILED — Step 0's class set is not class-probe's (#4730)"
	exit 1
fi
echo "verify-step0-class-parity: OK — 2 case(s); Step 0 prints class-probe's answer, including on a diff whose files classify as nothing"
