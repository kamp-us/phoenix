#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1090,SC1091,SC2016,SC2086
# SC2086 is deliberate throughout: `$SCRIPTS` and `$(sourced_by …)` are whitespace-separated lists
# whose splitting IS the iteration. The `$#`-eq-0 test after `set -- $SCRIPTS` is the zero-scope
# guard that would otherwise be the reason to prefer an array.
# Reviewer-runnable proof that ship-it's sourced chain RUNS AS WRITTEN — the property #4547 found
# false in three places at once. Three checks, one per defect shape, each falsifiable:
#
#   1. STATIC — every function a `ship-it/scripts/*.sh` calls is defined in that file, in something
#      that file sources, or in a script SKILL.md sources EARLIER in the chain. This is issue
#      #4547's fourth acceptance criterion, mechanized: an extraction that drops a source line
#      leaves a call that resolves nowhere, and nothing else in the repo notices.
#   2. EXECUTABLE — the Step-0 scripts are actually sourced, against stubbed `gh` / `pipeline-cli`,
#      and their stderr must carry no `command not found`. The static check says a name resolves;
#      this one says the shell agrees. Neither subsumes the other: static covers branches a run
#      does not take, executable covers resolution the regex could get wrong.
#   3. SEAM — `step2-verdict-gate.sh` must PASS THROUGH the caller's `$CP_FLAG`. Asserted on what
#      the stub `pipeline-cli` was actually handed, not on the script's text: `--cp` present when
#      the caller set it, absent when it did not, and a refusal on any third value.
#
# Hermetic: every network call is stubbed, so this needs no `gh` auth and touches no repo state.
#
# Usage:  bash claude-plugins/kampus-pipeline/skills/ship-it/scripts/verify-chain-resolves.sh
#
# Shell shape per .patterns/skill-script-shell-shape.md: `set -uo pipefail`, never `-e`, and no
# `EXIT` trap — on bash 3.2 `-e` plus a cleanup trap launders a `set -u` abort into exit 0, and this
# harness's whole contract is its exit status.
set -uo pipefail

DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SKILLS="$(CDPATH= cd -- "$DIR/../.." && pwd)"
SKILL_MD="$DIR/../SKILL.md"
fail=0

TMP="$(mktemp -d)"
if [ -z "$TMP" ] || [ ! -d "$TMP" ]; then
	echo "FAIL: mktemp -d produced no temp root — refusing to run against nothing (ADR 0092)"
	exit 1
fi

# ---------------------------------------------------------------------------------------------
# scope
# ---------------------------------------------------------------------------------------------
SCRIPTS=""
for f in "$DIR"/*.sh; do
	[ -f "$f" ] || continue                       # bash 3.2 has no nullglob here
	case "$(basename "$f")" in verify-*) continue ;; esac
	SCRIPTS="$SCRIPTS $f"
done
set -- $SCRIPTS
if [ "$#" -eq 0 ]; then
	echo "FAIL: zero scope — no ship-it step script resolved under $DIR (ADR 0092)"
	exit 1
fi
echo "scope: $# step script(s) under skills/ship-it/scripts, SKILL.md at skills/ship-it/SKILL.md"

# ---------------------------------------------------------------------------------------------
# 1. STATIC — every cross-file call resolves in-chain
# ---------------------------------------------------------------------------------------------
# The candidate names are the CROSS-FILE helper surface: everything defined in the plugin lib/,
# skills/shared/scripts, or a ship-it step script. A name defined only inside the file that calls it is
# reachable by construction and needs no check; names from unrelated skills are out of scope, and
# including them would match prose words (`fail`, `check`, `ok`) inside message strings.
defs_in() { grep -oE '^[a-zA-Z_][a-zA-Z0-9_]*\(\)' "$1" 2>/dev/null | sed 's/()$//'; }

CANDIDATES="$TMP/candidates"
: > "$CANDIDATES"
for f in "$SKILLS"/../lib/*.sh "$SKILLS"/shared/scripts/*.sh "$DIR"/*.sh; do
	[ -f "$f" ] || continue
	# `verify-*` / `*-test.sh` are harnesses, not helper surface: their private `ok`/`fail`
	# assertion shims are not names a step script could ever be calling.
	case "$(basename "$f")" in verify-*|*-test.sh) continue ;; esac
	defs_in "$f" >> "$CANDIDATES"
done
sort -u "$CANDIDATES" -o "$CANDIDATES"
CAND_N="$(grep -c . "$CANDIDATES" || true)"
if [ "$CAND_N" -eq 0 ]; then
	echo "FAIL: zero scope — no candidate helper name resolved; the audit would be vacuously green (ADR 0092)"
	exit 1
fi
echo "scope: $CAND_N cross-file helper name(s) in the candidate set"

# The files a script pulls in itself. Only the canonical in-chain form is recognized; anything else
# that looks like a source line is reported UNRESOLVED rather than assumed harmless (§ZS).
sourced_by() {
	sed -n 's|^\. "\$(CDPATH= cd -- "\$(dirname -- "\${BASH_SOURCE\[0\]}")/\(.*\)" && pwd)/\(.*\)"$|\1/\2|p' "$1" \
		| while IFS= read -r rel; do
			[ -z "$rel" ] && continue
			printf '%s\n' "$(CDPATH= cd -- "$(dirname -- "$1")" && pwd)/$rel"
		done
}

# The chain order SKILL.md itself establishes: a script sourced EARLIER in the doc has left its
# functions in the agent's shell by the time a later step runs. This is what makes
# `disarm_intent` — defined in disarm-intent.sh, sourced in SKILL.md's preamble — legitimately
# reachable from every step without any step sourcing it.
skill_md_line_of() {   # $1 = script basename; prints the line number of its SKILL.md source, or 0
	grep -n "SHIPIT_SCRIPTS/$1\"" "$SKILL_MD" 2>/dev/null | head -n1 | cut -d: -f1
}

for s in $SCRIPTS; do
	base="$(basename "$s")"
	reach="$TMP/reach"
	: > "$reach"
	defs_in "$s" >> "$reach"
	for dep in $(sourced_by "$s"); do
		if [ ! -f "$dep" ]; then
			printf 'BAD   %-26s sources a file that does not exist: %s\n' "$base" "$dep"
			fail=1
			continue
		fi
		defs_in "$dep" >> "$reach"
		for dep2 in $(sourced_by "$dep"); do
			[ -f "$dep2" ] && defs_in "$dep2" >> "$reach"
		done
	done
	# every source-looking line must have been recognized, or the reachable set is under-counted
	src_lines="$(grep -cE '^[[:space:]]*(\.|source) ' "$s" || true)"
	src_resolved="$(sourced_by "$s" | grep -c . || true)"
	if [ "$src_lines" -ne "$src_resolved" ]; then
		printf 'BAD   %-26s %s source line(s), %s resolved — an unrecognized source shape is UNKNOWN\n' \
			"$base" "$src_lines" "$src_resolved"
		fail=1
	fi
	# chain predecessors, per SKILL.md's own order
	mine="$(skill_md_line_of "$base")"
	[ -z "$mine" ] && mine=0
	for other in $SCRIPTS; do
		ob="$(basename "$other")"
		[ "$ob" = "$base" ] && continue
		ol="$(skill_md_line_of "$ob")"
		[ -z "$ol" ] && continue
		[ "$mine" -eq 0 ] && continue
		[ "$ol" -lt "$mine" ] && defs_in "$other" >> "$reach"
	done
	sort -u "$reach" -o "$reach"
	# calls: a candidate name in command position — not on a comment-only line, not its own
	# definition, and with trailing `#…` comments stripped so a name merely MENTIONED after code
	# is not read as a call.
	body="$TMP/body"
	grep -v '^[[:space:]]*#' "$s" | sed 's/[[:space:]]#.*$//' > "$body"
	while IFS= read -r name; do
		[ -z "$name" ] && continue
		grep -q "^${name}$" "$reach" && continue
		# `=` in the excluded prefix set: `VAR=ok` is a value, not a call.
		if grep -qE "(^|[^=A-Za-z0-9_./\"'-])${name}([[:space:]]|\$)" "$body"; then
			printf 'BAD   %-26s calls %s — defined in no file this chain sources\n' "$base" "$name"
			fail=1
		fi
	done < "$CANDIDATES"
done
echo "=== 1. static: every cross-file call resolves in-chain — see BAD lines above, if any"

# ---------------------------------------------------------------------------------------------
# stubs — a hermetic gh + pipeline-cli, so checks 2 and 3 run offline
# ---------------------------------------------------------------------------------------------
BIN="$TMP/bin"
PLUGIN="$TMP/plugin/bin"
mkdir -p "$BIN" "$PLUGIN" || { echo "FAIL: cannot create the stub dirs under $TMP"; exit 1; }

cat > "$BIN/gh" <<'STUB'
#!/usr/bin/env bash
# Hermetic `gh`: a changed-file list for the files endpoint, an empty (but successful) body for
# everything else. The scripts under test read both through their own fail-closed wrappers.
for a in "$@"; do
  case "$a" in
    */pulls/*/files*) printf 'claude-plugins/kampus-pipeline/skills/ship-it/SKILL.md\napps/web/src/App.tsx\n.decisions/0001-example.md\n'; exit 0 ;;
  esac
done
exit 0
STUB

cat > "$PLUGIN/pipeline-cli" <<'STUB'
#!/usr/bin/env bash
# Hermetic shim: records its argv so a caller can assert what it was HANDED, then answers each
# verb with a well-formed state word. Recording is the point — check 3 reads this file.
[ -n "${PCLI_CALLS:-}" ] && printf '%s\n' "$*" >> "$PCLI_CALLS"
case "${1:-}" in
  class-probe)          cat > /dev/null; printf 'skill\n' ;;
  # `content-undetermined` on purpose: it is the branch that reaches `cp_head_sha`, so the
  # executable check covers BOTH §CPREAD helpers rather than just the one on the happy path.
  cp-classify)          cat > /dev/null; printf 'content-undetermined\n' ;;
  guard-content-probe)  cat > /dev/null; printf 'not-guard-touching\n' ;;
  cp-cardinality)       cat > /dev/null ;;
esac
exit 0
STUB
chmod +x "$BIN/gh" "$PLUGIN/pipeline-cli"

# ---------------------------------------------------------------------------------------------
# 2. EXECUTABLE — sourcing the Step-0 scripts resolves every function they call
# ---------------------------------------------------------------------------------------------
# One driver invocation PER script, never one chained run: a script whose first unresolved call
# exits would otherwise take its successors' coverage down with it, and the harness would report a
# narrower scan as a clean one. Each run stands the script up on SKILL.md's own preamble
# (`disarm-intent.sh`) plus the two values Step 0 resolves, and nothing else.
cat > "$TMP/drive-one.sh" <<'DRV'
REPO="owner/repo"
PR=1
. "$SHIPIT/disarm-intent.sh"          # SKILL.md's preamble source — part of the chain
. "$SHIPIT/$STEP" ${STEP_ARG:-} > /dev/null
DRV

echo "=== 2. executable: no call in the Step-0 chain dies command-not-found"
# `CLAUDE_CODE_AGENT=` / `WORKTREE_ROOT=` blanked deliberately: `iso_preflight`'s isolation policy is
# not what is under test here, and inheriting an agent's env would make this harness's result depend
# on which checkout it was launched from.
for step in step0-preflight.sh step0-classify.sh step0-cp-approval.sh; do
	arg=""
	[ "$step" = "step0-preflight.sh" ] && arg=1
	STEP="$step" STEP_ARG="$arg" PATH="$BIN:$PATH" CLAUDE_PLUGIN_ROOT="$TMP/plugin" SHIPIT="$DIR" \
		CLAUDE_CODE_AGENT= WORKTREE_ROOT= bash "$TMP/drive-one.sh" > "$TMP/out" 2> "$TMP/err"
	if grep -q 'command not found' "$TMP/err"; then
		printf 'BAD   %-26s unresolved function(s):\n' "$step"
		grep 'command not found' "$TMP/err" | sed 's/^/      /'
		fail=1
	else
		printf 'OK    %-26s no '\''command not found'\'' on stderr\n' "$step"
	fi
done

# ---------------------------------------------------------------------------------------------
# 3. SEAM — $CP_FLAG reaches `verdict gate`
# ---------------------------------------------------------------------------------------------
cat > "$TMP/drive-gate.sh" <<'DRV'
REPO="owner/repo"
PR=1
. "$SHIPIT/disarm-intent.sh"
# Step 0's §CP discharge is the only writer of CP_FLAG; $SEAM stands in for it here.
[ -n "${SEAM:-}" ] && CP_FLAG="$SEAM"
. "$SHIPIT/step2-verdict-gate.sh"
DRV

run_gate() {   # $1 = the value Step 0 would have set (empty ⇒ Step 0 set nothing); prints nothing
	CALLS="$TMP/calls"
	: > "$CALLS"
	SEAM="$1" PCLI_CALLS="$CALLS" PATH="$BIN:$PATH" CLAUDE_PLUGIN_ROOT="$TMP/plugin" SHIPIT="$DIR" \
		bash "$TMP/drive-gate.sh" > "$TMP/gout" 2> "$TMP/gerr"
	GATE_RC=$?
	GATE_ARGS="$(grep '^verdict gate' "$CALLS" | tail -n1)"
}

echo "=== 3. seam: the caller's \$CP_FLAG reaches \`verdict gate\`"
run_gate "--cp"
case "$GATE_ARGS" in
	*--cp*) printf 'OK    §CP discharge  → handed: %s\n' "$GATE_ARGS" ;;
	*)      printf 'BAD   §CP discharge  → --cp DROPPED; verdict gate was handed: %s\n' "${GATE_ARGS:-<no call recorded>}"; fail=1 ;;
esac

run_gate ""
case "$GATE_ARGS" in
	*--cp*) printf 'BAD   non-§CP        → --cp appeared unbidden: %s\n' "$GATE_ARGS"; fail=1 ;;
	"")     printf 'BAD   non-§CP        → verdict gate was never invoked\n'; fail=1 ;;
	*)      printf 'OK    non-§CP        → handed: %s\n' "$GATE_ARGS" ;;
esac

run_gate "--CP-TYPO"
if [ "$GATE_RC" -ne 0 ] && grep -q 'CP_FLAG' "$TMP/gerr" && [ -z "$GATE_ARGS" ]; then
	printf 'OK    third value     → refused (rc=%s) with a named reason, verdict gate never invoked\n' "$GATE_RC"
else
	printf 'BAD   third value     → rc=%s, verdict gate handed: %s (expected a named non-zero refusal)\n' \
		"$GATE_RC" "${GATE_ARGS:-<none>}"
	fail=1
fi

rm -rf "$TMP"
if [ "$fail" -ne 0 ]; then
	echo "FAIL: ship-it's sourced chain does not run as written"
	exit 1
fi
echo "PASS: ship-it's sourced chain runs as written"
