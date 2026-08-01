#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC2016
# Reviewer-runnable four-case proof that `reviewer-append-ac.sh`'s fence 1 (append-only) is BOTH
# correct and non-vacuous. It runs the real script — no re-implementation of the fence — against an
# offline `gh` stub on PATH, so the whole proof is deterministic and touches no repo.
#
#   clean append   a real-shape body with NO trailing newline appends and PATCHes byte-for-byte
#   mutated line   a tampered rebuild that ALTERS a pre-existing line still aborts (exit 1)
#   dropped line   a tampered rebuild that DROPS a pre-existing line still aborts (exit 1)
#   control        the same dropped-line tamper with the guard neutered PATCHes the lossy body,
#                  which is what proves the two reds above come from the guard and not from the
#                  tamper failing to take effect
#
# The tampers are injected into a COPY of the script (one extra line after its `UPDATED=` rebuild),
# never into the shipped file: fence 1 guards against a rebuild that loses a line, and the shipped
# rebuild cannot produce one, so a negative direction is only observable by simulating the failure
# the fence exists for. Background: #4600 (both diff operands now share one normalizer).
#
# Runs under the bash the target actually has — `/bin/bash`, 3.2.57 on macOS — not the caller's.
# Override with KP_PROOF_BASH for a second interpreter.
set -uo pipefail

HERE="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/reviewer-append-ac.sh"
BASH_BIN="${KP_PROOF_BASH:-/bin/bash}"

if [ ! -f "$SCRIPT" ]; then
	echo "fence1-proof: $SCRIPT not found — NO case was run." >&2
	exit 1
fi
if [ ! -x "$BASH_BIN" ]; then
	echo "fence1-proof: interpreter $BASH_BIN not executable — NO case was run." >&2
	exit 1
fi

WORK="$(mktemp -d)"
if [ -z "$WORK" ] || [ ! -d "$WORK" ]; then
	echo "fence1-proof: mktemp -d produced no directory — NO case was run." >&2
	exit 1
fi
BIN="$WORK/bin"
# The variants live at the same depth under a mirror plugin root, because the script resolves the
# shared lib by a relative `../../../lib` hop — a copy at any other depth dies before fence 1.
VARIANTS="$WORK/plugin/skills/shared/scripts"
mkdir -p "$BIN" "$VARIANTS" || exit 1
ln -s "$HERE/../../../lib" "$WORK/plugin/lib" || exit 1
export KP_PROOF_BODY_FILE="$WORK/body.txt"
export KP_PROOF_PATCH_FILE="$WORK/patched.txt"
export CLAUDE_PIPELINE_REPO="kamp-us/fence1-proof-fixture"

# The fixture body is the real shape — an `### Acceptance criteria` list — delivered exactly as
# `gh api … --jq .body` delivers it: with NO trailing newline. That is the shape #4600 aborted on.
printf '%s' '## What to build

Something observable.

### Acceptance criteria

- [ ] a pre-existing criterion
- [ ] another pre-existing criterion' > "$KP_PROOF_BODY_FILE"

cat > "$BIN/gh" <<'STUB'
#!/usr/bin/env bash
# Offline stand-in for `gh`, answering only the four calls reviewer-append-ac.sh makes.
set -uo pipefail
case "$*" in
	"api user --jq .login") printf 'fixture-reviewer\n'; exit 0 ;;
	*permission*) printf 'write\n'; exit 0 ;;
esac
is_patch=0
for a in "$@"; do
	if [ "$a" = "PATCH" ]; then is_patch=1; fi
done
if [ "$is_patch" = 1 ]; then
	for a in "$@"; do
		case "$a" in
			(body=*) printf '%s' "${a#body=}" > "$KP_PROOF_PATCH_FILE" ;;
		esac
	done
	exit 0
fi
cat "$KP_PROOF_BODY_FILE"
STUB
chmod +x "$BIN/gh" || exit 1

NEW_ROW='- [ ] a newly appended criterion <!-- ac:review-code pr:#701 round:1 -->'
{ cat "$KP_PROOF_BODY_FILE"; printf '\n%s' "$NEW_ROW"; } > "$WORK/expected.txt"

# A copy of the script with one shell line injected after its `UPDATED=` rebuild (empty = verbatim),
# optionally with the fence-1 abort neutered — the control.
variant() { # <inject-line> <neuter-guard:0|1> <outfile>
	awk -v inj="$1" -v neuter="$2" '
		{ line = $0 }
		neuter == 1 && line ~ /^if printf .*grep -qE .*then$/ { line = "if false; then" }
		{ print line }
		!seen && $0 ~ /^UPDATED=/ { if (inj != "") print inj; seen = 1 }
	' "$SCRIPT" > "$3"
}

RUN_OUT=""
RUN_RC=0
run_case() { # <script-path>
	rm -f "$KP_PROOF_PATCH_FILE"
	RUN_OUT="$(PATH="$BIN:$PATH" "$BASH_BIN" "$1" 700 701 1 review-code "a newly appended criterion" "an in-scope finding" 2>&1)"
	RUN_RC=$?
}

CASES=0
FAILS=0
ok() { # <label> <condition-description> <0|1 result>
	CASES=$((CASES + 1))
	if [ "$3" = 1 ]; then
		printf 'PASS  %-14s %s\n' "$1" "$2"
	else
		printf 'FAIL  %-14s %s\n' "$1" "$2"
		printf '      rc=%s output:\n%s\n' "$RUN_RC" "$RUN_OUT"
		FAILS=$((FAILS + 1))
	fi
}

printf 'fence1-proof: interpreter %s — %s\n' "$BASH_BIN" "$("$BASH_BIN" --version | head -1)"
printf 'fence1-proof: script under proof %s\n\n' "$SCRIPT"

# ── 1. clean append ────────────────────────────────────────────────────────────────────────
variant "" 0 "$VARIANTS/clean.sh"
run_case "$VARIANTS/clean.sh"
r=0
if [ "$RUN_RC" = 0 ] && printf '%s\n' "$RUN_OUT" | grep -q 'APPEND-STATE: appended' && cmp -s "$KP_PROOF_PATCH_FILE" "$WORK/expected.txt"; then r=1; fi
ok "clean-append" "no abort on a body with no trailing newline; PATCHed body is byte-for-byte prior + one row" "$r"

# ── 2. mutated pre-existing line ───────────────────────────────────────────────────────────
# No backslash survives `awk -v`, so the tamper patterns carry none — they key on the fixture's
# criterion TEXT rather than on its `- [ ]` prefix, whose brackets would otherwise need escaping.
variant 'UPDATED="$(printf '"'"'%s'"'"' "$UPDATED" | sed '"'"'s/another pre-existing criterion/another pre-existing criterion MUTATED/'"'"')"' 0 "$VARIANTS/mutated.sh"
run_case "$VARIANTS/mutated.sh"
r=0
if [ "$RUN_RC" = 1 ] && printf '%s\n' "$RUN_OUT" | grep -q 'append-only violation' && [ ! -f "$KP_PROOF_PATCH_FILE" ]; then r=1; fi
ok "mutated-line" "aborts (exit 1, 'append-only violation') and PATCHes nothing" "$r"

# ── 3. dropped pre-existing line ───────────────────────────────────────────────────────────
DROP_TAMPER='UPDATED="$(printf '"'"'%s'"'"' "$UPDATED" | grep -v '"'"'another pre-existing criterion'"'"')"'
variant "$DROP_TAMPER" 0 "$VARIANTS/dropped.sh"
run_case "$VARIANTS/dropped.sh"
r=0
if [ "$RUN_RC" = 1 ] && printf '%s\n' "$RUN_OUT" | grep -q 'append-only violation' && [ ! -f "$KP_PROOF_PATCH_FILE" ]; then r=1; fi
ok "dropped-line" "aborts (exit 1, 'append-only violation') and PATCHes nothing" "$r"

# ── 4. control: same drop, guard neutered ──────────────────────────────────────────────────
variant "$DROP_TAMPER" 1 "$VARIANTS/control.sh"
run_case "$VARIANTS/control.sh"
r=0
if [ "$RUN_RC" = 0 ] && printf '%s\n' "$RUN_OUT" | grep -q 'APPEND-STATE: appended' && [ -f "$KP_PROOF_PATCH_FILE" ] && ! grep -q 'another pre-existing criterion' "$KP_PROOF_PATCH_FILE"; then r=1; fi
ok "guard-disabled" "with the guard neutered the same drop PATCHes a lossy body — the red above is the guard's" "$r"

rm -rf "$WORK"

printf '\nfence1-proof: %s case(s), %s failure(s)\n' "$CASES" "$FAILS"
if [ "$CASES" -ne 4 ]; then
	echo "fence1-proof: expected 4 cases, ran $CASES — the proof did not cover its own scope." >&2
	exit 1
fi
[ "$FAILS" -eq 0 ]
