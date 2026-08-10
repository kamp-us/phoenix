#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC2016
# SC2016 is declared, not waved off: the mutant generators' sed programs are LITERAL text —
# expanding their `$#` / `$1` here would rewrite the mutants into something else.
#
# Reviewer-runnable proof that apply-triage.sh forwards every argument it is given, and refuses —
# loudly, non-zero, before any write — when it cannot.
#
# The defect (#4936): the wrapper took `-ge 3` and forwarded `$1 $2 $3`, so a trailing
# `--status needs-info` was accepted, discarded, and the run exited 0 having applied
# `status:triaged`. That direction is what makes it worse than an ordinary dropped argument —
# `status:triaged` + unassigned is exactly write-code's pick predicate, so the hold a triager
# thought they had applied landed PICKABLE, with nothing in the exit status or on stdout to say so.
#
# So the property under test is two-sided, and neither side alone is the fix:
#   (1) POSITIVE — a well-formed invocation reaches the verb with EVERY argument intact. Asserted on
#       the verb's actual argv, not on a clean exit: an exit 0 is what the defect already produced.
#   (2) LOUD — an invocation the wrapper cannot forward in full exits non-zero with a diagnostic and
#       spawns the verb ZERO times. A partial application is the failing case, not a lesser pass.
#
# Falsifiability is asserted, not assumed: five MUTANTS each revert one claim the fix rests on, and
# each is required to reproduce its OWN failure — matched on the specific wrong argv or the specific
# wrong exit, never on "something went red", which a mutant that merely fails to start also does.
#
# Hermetic: the verb is a stub that records its argv, so this needs no auth, no network, and mutates
# no issue.
#
# Usage:  bash claude-plugins/kampus-pipeline/skills/triage/scripts/verify-apply-triage-args.sh
#
# Shell shape per .patterns/skill-script-shell-shape.md: `set -uo pipefail`, never `-e`, and no
# `EXIT` trap — on bash 3.2 `-e` plus a cleanup trap launders a `set -u` abort into exit 0, and this
# harness's whole contract is its exit status.
set -uo pipefail

# PHYSICAL resolution (`cd -P` / `pwd -P`): CI and agents reach this through the `.claude/skills`
# symlink, where a logically-folded `..` lands on `.claude/` — which has no `lib/`, so every mutant
# would die at lib resolution and score as "caught" while testing nothing.
DIR="$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd -P)"
SUT="$DIR/apply-triage.sh"
fail=0

if [ ! -f "$SUT" ]; then
	echo "FAIL: zero scope — $SUT does not exist (ADR 0092)"
	exit 1
fi

TMP="$(mktemp -d)"
if [ -z "$TMP" ] || [ ! -d "$TMP" ]; then
	echo "FAIL: mktemp -d produced no temp root — refusing to run against nothing (ADR 0092)"
	exit 1
fi

PLUGIN="$TMP/plugin"
mkdir -p "$PLUGIN/bin" || { echo "FAIL: cannot create the stub plugin root under $TMP"; exit 1; }

# The verb stub records one line per spawn: the full argv it was handed, tab-separated. Its absence
# is therefore evidence the wrapper refused before spawning anything — which is what "no partial
# application" means operationally.
cat > "$PLUGIN/bin/pipeline-cli" <<'STUB'
#!/usr/bin/env bash
printf '%s\t' "$@" >> "$PCLI_LOG"
printf '\n' >> "$PCLI_LOG"
exit 0
STUB
chmod +x "$PLUGIN/bin/pipeline-cli" || { echo "FAIL: cannot chmod the verb stub"; exit 1; }

LOG="$TMP/argv.log"

run_case() {   # $1 = script under test, $2… = the invocation's arguments
	local script="$1"
	shift
	: > "$LOG"
	ERR="$TMP/err"
	# The wrapper's own stdout is the verb's, which the stub does not print — the recorded argv is
	# the observation, so stdout is parked in a file rather than captured.
	PCLI_LOG="$LOG" CLAUDE_PLUGIN_ROOT="$PLUGIN" bash "$script" "$@" >"$TMP/out" 2>"$ERR"
	RC=$?
	ARGV="$(cat "$LOG")"
	ERRTEXT="$(cat "$ERR")"
	SPAWNS="$(grep -c . "$LOG")"
}

# A forwarded invocation: the verb ran exactly once and its argv is EXACTLY the expected line. An
# argv substring match would let a dropped trailing flag pass, which is the defect itself.
check_forwarded() {   # $1 = label, $2 = expected tab-joined argv
	if [ "$RC" -ne 0 ]; then
		printf 'BAD   %-44s expected exit 0, exited %s (%s)\n' "$1" "$RC" "${ERRTEXT:-<no stderr>}"
		fail=1
		return
	fi
	if [ "$SPAWNS" -ne 1 ]; then
		printf 'BAD   %-44s expected exactly 1 verb spawn, saw %s\n' "$1" "$SPAWNS"
		fail=1
		return
	fi
	if [ "$ARGV" != "$2	" ]; then
		printf 'BAD   %-44s argv mismatch\n        want: %s\n        got:  %s\n' "$1" "$2" "$ARGV"
		fail=1
		return
	fi
	printf 'OK    %-44s forwarded: %s\n' "$1" "$2"
}

# A refused invocation: non-zero, a diagnostic naming the reason, and — the load-bearing half — ZERO
# verb spawns, so nothing was partially applied on the way to the refusal.
check_refused() {   # $1 = label, $2 = substring the stderr diagnostic must carry
	if [ "$RC" -eq 0 ]; then
		printf 'BAD   %-44s must refuse, exited 0 (argv: %s)\n' "$1" "${ARGV:-<none>}"
		fail=1
		return
	fi
	if [ "$SPAWNS" -ne 0 ]; then
		printf 'BAD   %-44s refused but still spawned the verb %s time(s): %s\n' "$1" "$SPAWNS" "$ARGV"
		fail=1
		return
	fi
	if ! printf '%s' "$ERRTEXT" | grep -q "$2"; then
		printf 'BAD   %-44s stderr missing %-30s got: %s\n' "$1" "$2" "${ERRTEXT:-<empty>}"
		fail=1
		return
	fi
	printf 'OK    %-44s refused (%s), no write\n' "$1" "$2"
}

echo "scope: $SUT, driven under 11 invocations + 5 mutants"

# --- POSITIVE: every argument reaches the verb ----------------------------------------------------
run_case "$SUT" 4936 bug p1
check_forwarded "3-arg path (unchanged)" "tracker	apply-triage	4936	--type	bug	--p	p1	--status	triaged"

run_case "$SUT" 4936 bug p1 --status planned
check_forwarded "trailing --status is APPLIED" "tracker	apply-triage	4936	--type	bug	--p	p1	--status	planned"

run_case "$SUT" 4936 --status needs-info
check_forwarded "the park (no type, no priority)" "tracker	apply-triage	4936	--status	needs-info"

run_case "$SUT" 4936 --status=needs-info
check_forwarded "--status=<stage> joined form" "tracker	apply-triage	4936	--status	needs-info"

run_case "$SUT" --status planned 4936 chore p2
check_forwarded "leading --status, positionals after" "tracker	apply-triage	4936	--type	chore	--p	p2	--status	planned"

# --- LOUD: what cannot be forwarded in full is fatal, and applies NOTHING --------------------------
run_case "$SUT" 4936 bug p1 extra
check_refused "4th bare positional (the arity half)" "expected 3 positionals"

run_case "$SUT" 4936 bug p1 --status
check_refused "--status with no stage" "needs a stage"

run_case "$SUT" 4936 bug p1 --sttaus needs-info
check_refused "misspelled/unknown flag" "unrecognized flag"

run_case "$SUT" 4936 bug p1 --status a --status b
check_refused "--status given twice" "more than once"

run_case "$SUT" 4936
check_refused "bare <N>, no stage and no facets" "applies nothing"

run_case "$SUT" bug p1 4936
check_refused "non-numeric <N> (transposed args)" "must be an issue number"

# --- falsifiability: every claim above must go red under a mutant that reverts it ------------------
#
# A mutant must live at the SAME depth as the original: apply-triage.sh sources the shared lib
# through `../../../lib`, so a mutant dropped in a flat temp dir dies at lib resolution — a non-zero
# exit that a loose "it refused" assertion would score as caught for entirely the wrong reason.
# Hence a mirrored tree, and hence every expectation below naming its own outcome precisely.
PLUGIN_SRC="$(CDPATH= cd -P -- "$DIR/../../.." && pwd -P)"
MUT_DIR="$TMP/tree/skills/triage/scripts"
mkdir -p "$MUT_DIR" || { echo "FAIL: cannot create the mutant tree under $TMP"; exit 1; }
ln -s "$PLUGIN_SRC/lib" "$TMP/tree/lib" || { echo "FAIL: cannot mirror the shared lib"; exit 1; }

mutate() {   # $1 = name, $2… = sed programs
	local name="$1"
	shift
	MUTANT="$MUT_DIR/mutant-$name.sh"
	cp "$SUT" "$MUTANT" || return 1
	local prog
	for prog in "$@"; do
		sed "$prog" "$MUTANT" > "$MUTANT.tmp" && mv "$MUTANT.tmp" "$MUTANT"
	done
	if cmp -s "$SUT" "$MUTANT"; then
		printf 'BAD   %-44s the mutant is byte-identical to the original — it reverts nothing\n' "$name"
		fail=1
		return 1
	fi
	return 0
}

# The reverted behaviour is asserted on the ARGV the verb saw (or on its absence), never on a bare
# non-zero: a mutant that fails to start is also non-zero, and scoring that as "caught" is how a
# mutation suite passes while testing nothing.
expect_argv() {   # $1 = name, $2 = the argv line the BROKEN wrapper forwards, $3 = why it has teeth
	if [ "$ARGV" = "$2	" ]; then
		printf 'OK    %-44s %s\n' "$1" "$3"
	else
		printf 'BAD   %-44s expected the reverted argv\n        want: %s\n        got:  %s\n' "$1" "$2" "${ARGV:-<no spawn>}"
		fail=1
	fi
}

# M1 — the filed defect verbatim: `-ge 3` arity + forward only $1 $2 $3. The trailing `--status
# needs-info` is swallowed and `status:triaged` is what lands.
if mutate asfiled '/^while \[ "\$#" -gt 0 \]; do$/,/^fi$/d'; then
	cat >> "$MUTANT" <<'ASFILED'
[ "$#" -ge 3 ] || { echo "usage: apply-triage.sh <N> <type> <priority>" >&2; exit 2; }
PCLI="$(kp_pcli)" || exit 127
"$PCLI" tracker apply-triage "$1" --type "$2" --p "$3"
ASFILED
	run_case "$MUTANT" 4936 bug p1 --status needs-info
	expect_argv "M1 the code as filed (#4936)" "tracker	apply-triage	4936	--type	bug	--p	p1" \
		"reproduces the drop: the hold is discarded and status:triaged lands"
fi

# M2 — the `-*` catch-all refuses nothing and just steps over the flag and its value, which is how
# an unrecognized flag gets swallowed instead of surfaced.
if mutate noflagguard 's%^			refuse "unrecognized flag.*%			shift 2%'; then
	run_case "$MUTANT" 4936 bug p1 --sttaus needs-info
	expect_argv "M2 unknown-flag refusal deleted" "tracker	apply-triage	4936	--type	bug	--p	p1	--status	triaged" \
		"a typo'd flag is absorbed instead of refused"
fi

# M3 — the exact positional count goes back to `-ge`-style tolerance, so a 4th bare word is dropped.
# The flag-shaped refusal that #4854 will land corpus-wide does NOT catch this one: `extra` has no
# leading dash.
if mutate arityloose \
	's%^	\*) refuse "expected 3 positionals.*$%	*) : ;;%' \
	's%-eq 3 \]; then$%-ge 3 ]; then%'; then
	run_case "$MUTANT" 4936 bug p1 extra
	expect_argv "M3 exact arity relaxed" "tracker	apply-triage	4936	--type	bug	--p	p1	--status	triaged" \
		"the arity half is independent of flag shape — 'extra' is dropped in silence"
fi

# M4 — `--status` is parsed but never forwarded (the defect's shape, one layer in): the wrapper
# consumes the flag and the verb still applies its default.
if mutate notforwarded 's%^		--type "\${POSITIONAL\[1\]}" --p "\${POSITIONAL\[2\]}" --status "\$STATUS"$%		--type "${POSITIONAL[1]}" --p "${POSITIONAL[2]}"%'; then
	run_case "$MUTANT" 4936 bug p1 --status planned
	expect_argv "M4 --status parsed, not forwarded" "tracker	apply-triage	4936	--type	bug	--p	p1" \
		"consuming the flag without forwarding it is the same silent drop"
fi

# M5 — the numeric-<N> guard is dropped, so a transposed invocation addresses the verb with a word
# where the issue number belongs instead of refusing.
if mutate nonnumeric "/must be an issue number/d"; then
	run_case "$MUTANT" bug p1 4936
	expect_argv "M5 numeric <N> guard deleted" "tracker	apply-triage	bug	--type	p1	--p	4936	--status	triaged" \
		"a transposed argv reaches the verb addressed at a non-issue"
fi

rm -rf "$TMP"
if [ "$fail" -ne 0 ]; then
	echo "FAIL: apply-triage.sh drops an argument, or a refusal is not loud and write-free"
	exit 1
fi
echo "PASS: every argument reaches the verb, and what cannot be forwarded refuses non-zero with no write"
