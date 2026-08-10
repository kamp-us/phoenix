#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC2016,SC2086
# SC2016 is declared, not waved off: the mutant generator's sed program matches the LITERAL text
# `$DROPPED` in the script under test, so expanding it here would delete nothing.
# Reviewer-runnable proof that Step 3z's close→reopen fires ONLY in the dropped-trigger state (#4830).
#
# Step 3z is the one ship-it step that takes a destructive server-side action on a live PR, and its
# precondition used to live entirely in the caller's prose classification: on PR #4816 a fully-green
# head was close→reopened and given a durable comment claiming zero workflow runs. So the property
# under test is not "the script runs" but "the script REFUSES to mutate a PR whose head is not in
# the state the remedy is for", in every direction the numbers can fail — including unreadable.
#
# Falsifiability is asserted, not assumed: the harness generates a MUTANT with the precondition
# block deleted and requires the not-dropped case to nudge under it. An assertion that passes on the
# mutant too would be testing nothing.
#
# Hermetic: `gh` and `pipeline-cli` are stubbed, so this needs no auth and touches no PR.
#
# Usage:  bash claude-plugins/kampus-pipeline/skills/ship-it/scripts/verify-step3z-precondition.sh
#
# Shell shape per .patterns/skill-script-shell-shape.md: `set -uo pipefail`, never `-e`, and no
# `EXIT` trap — on bash 3.2 `-e` plus a cleanup trap launders a `set -u` abort into exit 0, and this
# harness's whole contract is its exit status.
set -uo pipefail

DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SUT="$DIR/step3z-dropped-trigger.sh"
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

BIN="$TMP/bin"
PLUGIN="$TMP/plugin/bin"
mkdir -p "$BIN" "$PLUGIN" || { echo "FAIL: cannot create the stub dirs under $TMP"; exit 1; }

# The stubs answer each read with the number the CASE sets, and RECORD every call — the mutation
# assertions read that log, never the script's own narration of what it did.
cat > "$BIN/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GH_CALLS"
for a in "$@"; do
  case "$a" in
    */actions/workflows*)  [ "$STUB_NWF"   = FAIL ] && exit 1; printf '%s\n' "$STUB_NWF"; exit 0 ;;
    */actions/runs*)       [ "$STUB_NRUNS" = FAIL ] && exit 1; printf '%s\n' "$STUB_NRUNS"; exit 0 ;;
    */commits/*)           printf '2026-01-01T00:00:00Z\n'; exit 0 ;;
    */events*)             printf '%s\n' "$STUB_NUDGES"; exit 0 ;;
  esac
done
exit 0
STUB

cat > "$PLUGIN/pipeline-cli" <<'STUB'
#!/usr/bin/env bash
case "$1 ${2:-}" in
  "checks read")        [ "$STUB_CONTEXTS" = FAIL ] && exit 1
                        printf '{"conclusion":"green","contexts":%s,"running":[],"wedged":[],"failing":[]}\n' "$STUB_CONTEXTS" ;;
  "merge-intent disarm") ;;
esac
exit 0
STUB
chmod +x "$BIN/gh" "$PLUGIN/pipeline-cli"

# One case = one run of the script under one head state. `$OUT` is its stdout, `$CALLS` every gh
# call it made.
run_case() {   # $1 = script, $2 = CONTEXTS, $3 = NWF, $4 = NRUNS, $5 = prior nudges
	CALLS="$TMP/calls"
	: > "$CALLS"
	OUT="$(GH_CALLS="$CALLS" STUB_CONTEXTS="$2" STUB_NWF="$3" STUB_NRUNS="$4" STUB_NUDGES="$5" \
		PATH="$BIN:$PATH" CLAUDE_PLUGIN_ROOT="$TMP/plugin" \
		bash "$1" owner/repo 1 deadbeefdeadbeefdeadbeefdeadbeefdeadbeef 2>"$TMP/err")"
}

mutated() { grep -q 'PATCH' "$CALLS" || grep -q 'comments' "$CALLS"; }

# `no-mutate` is the refusal contract: no close→reopen AND no comment — a comment here would be the
# false dropped-trigger claim. `no-patch` is the pre-existing exhausted outcome, which deliberately
# leaves its durable #1928 comment; only the close→reopen is forbidden there.
check() {   # $1 = label, $2 = expected terminal substring, $3 = mutate|no-patch|no-mutate
	if ! printf '%s' "$OUT" | grep -q "$2"; then
		printf 'BAD   %-34s stdout missing %-46s got: %s\n' "$1" "$2" "${OUT:-<empty>}"
		fail=1
		return
	fi
	if [ "$3" = no-mutate ] && mutated; then
		printf 'BAD   %-34s REFUSED but still mutated the PR:\n' "$1"
		sed 's/^/      /' "$CALLS"
		fail=1
		return
	fi
	if [ "$3" = no-patch ] && grep -q 'PATCH' "$CALLS"; then
		printf 'BAD   %-34s close→reopened the PR anyway:\n' "$1"
		sed 's/^/      /' "$CALLS"
		fail=1
		return
	fi
	if [ "$3" = mutate ] && ! grep -q 'state=closed' "$CALLS"; then
		printf 'BAD   %-34s expected the close→reopen nudge, none recorded\n' "$1"
		fail=1
		return
	fi
	printf 'OK    %-34s %s\n' "$1" "$2"
}

echo "scope: $SUT, driven under 6 head states + 1 mutant"

# --- the two PRE-EXISTING terminal outcomes, preserved -------------------------------------------
run_case "$SUT" 0 45 0 0
check "genuine dropped trigger" "nudged (close→reopen)" mutate
run_case "$SUT" 0 45 0 1
check "nudge exhausted" "unverified (no runs fired" no-patch

# --- the refusal, in every direction the precondition can fail ------------------------------------
# The #4816 shape: a fully-green head handed to the remedy by a mis-read branch.
run_case "$SUT" 45 45 33 0
check "green head (#4816 shape)" "refused (not the dropped-trigger state" no-mutate
run_case "$SUT" 0 45 FAIL 0
check "NRUNS unreadable" "NRUNS=unreadable" no-mutate
run_case "$SUT" FAIL 45 0 0
check "CONTEXTS unreadable" "CONTEXTS=unreadable" no-mutate
# A repo that runs no Actions has a genuinely empty check set — not a dropped trigger.
run_case "$SUT" 0 0 0 0
check "repo runs no Actions" "refused (not the dropped-trigger state" no-mutate

# --- falsifiability: the assertions must FAIL on a mutant that drops the precondition --------------
MUTANT="$TMP/mutant.sh"
sed '/^if \[ "\$DROPPED" -ne 1 \]; then$/,/^fi$/d' "$SUT" > "$MUTANT"
if ! cmp -s "$SUT" "$MUTANT"; then
	run_case "$MUTANT" 45 45 33 0
	if mutated; then
		printf 'OK    %-34s the mutant nudges the green head — the refusal assertions have teeth\n' "mutant reverts the fix"
	else
		printf 'BAD   %-34s the mutant did NOT nudge; the refusal assertions would pass without the fix\n' "mutant reverts the fix"
		fail=1
	fi
else
	printf 'BAD   %-34s found no precondition block to delete — the mutant is the original\n' "mutant reverts the fix"
	fail=1
fi

rm -rf "$TMP"
if [ "$fail" -ne 0 ]; then
	echo "FAIL: Step 3z can close→reopen a PR outside the dropped-trigger state"
	exit 1
fi
echo "PASS: Step 3z nudges only in the dropped-trigger state, and refuses without mutating otherwise"
