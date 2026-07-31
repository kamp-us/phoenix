#!/usr/bin/env bash
# The reviewer-runnable harness for #4452's extraction, covering BOTH halves of the planning gate —
# plan-epic and review-plan. It is committed rather than pasted as a results table so a gate can
# RE-RUN it instead of trusting a claim (#4449's precedent).
#
# usage: verify-extraction.sh            # both skills
#        verify-extraction.sh <skill> …  # a named subset
#
# Nine checks, each fail-closed and each printing what it scanned. FAILS CLOSED ON ZERO SCOPE
# (ADR 0092): a run that resolved no SKILL.md or no scripts is a FAIL, never a silent pass. This
# harness excludes ITSELF from the extracted-script set — it is the verifier, not moved shell.
#
#   1. INVOCATION-ONLY — every fenced bash/sh block left in each SKILL.md contains nothing but
#      script invocations (comments, blanks and trailing `\` continuations allowed); no multi-line
#      glue remains.
#   2. NO BARE `pipeline-cli` — the extracted scripts reach the shim only through `kp_pcli`, so a
#      PATH-resolved `pipeline-cli` (not on PATH, ADR 0207) cannot re-enter the corpus.
#   3. NO USER-LOCAL PATHS — no /Users/<name> or /home/<name> absolute path. This is the check
#      whose CI counterpart does NOT reach a `.sh`: leak-guard's DOC_SUFFIXES is
#      [".md",".mdx",".markdown"] (packages/pipeline-cli/src/tools/leak-guard/leak-guard.ts), so a
#      `.sh` is out of its scope until #4496 lands. Until then THIS is the only thing holding the
#      property for these files.
#   4. SHELLCHECK — `shellcheck -x` clean on every extracted script (reported as a SKIP with no
#      result, never as a pass, when the binary is absent).
#   5. SOURCES THE SHARED LIB — every script sources ../../../lib/common.sh, so no skill-local
#      copy of kp_repo / kp_pcli / kp_scratch_* can drift (the PR #4485 lesson: source, don't copy).
#   6. NO CLEANUP TRAP ON EXIT — on bash 3.2 such a trap makes its last command the script's exit
#      status, laundering a `set -u` abort into exit 0 (#4476, class #4479).
#   7. NO UNGUARDED EMPTY-ARRAY EXPANSION — `"${arr[@]}"` on an EMPTY array aborts under `set -u` on
#      bash 3.2, so an array built conditionally must be non-empty by construction or length-guarded.
#   8. SHIM MISS IS 127 WITH EMPTY STDOUT — probed live on the shared primitive (`kp_pcli` under a
#      bogus CLAUDE_PLUGIN_ROOT), asserting BOTH the captured exit code and the captured stdout byte
#      count; plus every script that reaches a verb resolves it as `PCLI="$(kp_pcli)" || exit 127`,
#      so a could-not-run can never surface as an answer. Network-free.
#   9. USAGE MISS IS NON-ZERO WITH EMPTY STDOUT — every script that takes arguments, run with none,
#      asserted on BOTH the captured exit code and the captured stdout byte count. Network-free
#      (the usage guard precedes every `gh` call).
#
# Checks 2, 6 and 7 match against a COMMENT-STRIPPED copy of each script (everything from the first
# `#` on a line is dropped) so the skills can keep *writing about* a bare shim, a cleanup trap, or an
# empty-array expansion in the prose that explains why each is forbidden. That strip is naive about a
# `#` inside a string literal, which errs toward scanning less of a line — never toward passing a
# line it should have read, since a real violation is executable code and sits before any comment.
set -uo pipefail

# shellcheck disable=SC1007  # `CDPATH= cd` is the corpus idiom: an empty CDPATH for this one command
SKILLS_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1007
SELF="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/$(basename -- "${BASH_SOURCE[0]}")"
SKILLS=(plan-epic review-plan)
[ "$#" -gt 0 ] && SKILLS=("$@")

errors=0
checks=0
scanned_md=0
scanned_sh=0
fail() { echo "FAIL: $*"; errors=$((errors + 1)); }
ok() { echo "ok: $*"; checks=$((checks + 1)); }

# A comment-stripped copy of every extracted script, one per line as `<path>:<lineno>:<code>`.
code_lines() {
	local f
	for f in "${SCRIPT_PATHS[@]}"; do
		sed -e 's/#.*$//' "$f" | grep -n . | sed -e "s|^|$f:|"
	done
}

SCRIPT_PATHS=()
for skill in "${SKILLS[@]}"; do
	md="$SKILLS_DIR/$skill/SKILL.md"
	dir="$SKILLS_DIR/$skill/scripts"
	[ -f "$md" ] || { fail "$skill: no SKILL.md at $md"; continue; }
	[ -d "$dir" ] || { fail "$skill: no scripts/ dir at $dir"; continue; }
	scanned_md=$((scanned_md + 1))
	while IFS= read -r f; do
		[ -n "$f" ] || continue
		[ "$f" = "$SELF" ] && continue   # the harness is not moved shell
		SCRIPT_PATHS+=("$f")
		scanned_sh=$((scanned_sh + 1))
	done < <(find "$dir" -type f -name '*.sh' | LC_ALL=C sort)

	# 1. every remaining fenced bash/sh block contains only script invocations
	bad="$(awk -v skill="$skill" '
		/^[[:space:]]*```(bash|sh)[[:space:]]*$/ { inb=1; start=NR; n=0; inv=0; cont=0; next }
		inb && /^[[:space:]]*```[[:space:]]*$/ {
			if (n == 0 || inv != n) printf "%s:%d (payload lines=%d, invocations=%d)\n", skill, start, n, inv
			inb=0; next
		}
		inb {
			line=$0
			sub(/^[[:space:]]+/, "", line)
			if (line == "" || line ~ /^#/) next          # comments and blanks are not glue
			if (cont) { cont = (line ~ /\\$/); next }    # a continuation of the counted line
			n++
			if (line ~ /skills\/[a-z-]+\/scripts\/[a-z0-9_-]+\.sh/) inv++
			cont = (line ~ /\\$/)
		}
	' "$md")"
	if [ -n "$bad" ]; then
		fail "$skill/SKILL.md: fenced block(s) carry something other than script invocations:"
		printf '  %s\n' "$bad"
	else
		ok "$skill/SKILL.md: every fenced bash/sh block carries only scripts/*.sh invocations"
	fi
done

if [ "$scanned_md" -eq 0 ] || [ "$scanned_sh" -eq 0 ]; then
	fail "zero scope: resolved $scanned_md SKILL.md and $scanned_sh script(s) — refusing to report a pass over nothing (ADR 0092)"
	echo "verify-extraction: FAILED — $errors error(s)"
	exit 1
fi

# 2. no bare `pipeline-cli` token in executable code — the shim is reached only through kp_pcli
if hits="$(code_lines | grep -E '(^|[^/[:alnum:]_-])pipeline-cli([[:space:]]|$)' || true)"; [ -n "$hits" ]; then
	fail "bare \`pipeline-cli\` token(s) in executable code — resolve the shim through kp_pcli (ADR 0207):"
	printf '  %s\n' "$hits"
else
	ok "no bare \`pipeline-cli\` token in the executable code of any extracted script (${#SCRIPT_PATHS[@]} file(s))"
fi

# 3. no user-local absolute paths anywhere in the file, comments included (the #4496 scope gap)
if hits="$(grep -nE '/(Users|home)/[A-Za-z0-9._-]+' "${SCRIPT_PATHS[@]}" || true)"; [ -n "$hits" ]; then
	fail "user-local absolute path(s) in an extracted script:"
	printf '  %s\n' "$hits"
else
	ok "no /Users/<name> or /home/<name> path in any extracted script (${#SCRIPT_PATHS[@]} file(s))"
fi

# 4. shellcheck
if command -v shellcheck >/dev/null 2>&1; then
	if out="$(shellcheck -x "${SCRIPT_PATHS[@]}" 2>&1)"; then
		ok "shellcheck -x clean on all ${#SCRIPT_PATHS[@]} extracted script(s)"
	else
		fail "shellcheck -x findings:"
		printf '%s\n' "$out"
	fi
else
	echo "SKIP: shellcheck not installed — check 4 produced NO result (not a pass)"
fi

# 5. every script sources the shared lib
missing=""
for f in "${SCRIPT_PATHS[@]}"; do
	grep -qF '../../../lib" && pwd)/common.sh' "$f" || missing="$missing $f"
done
if [ -n "$missing" ]; then
	fail "script(s) that do not source the plugin lib/common.sh (a local copy would drift):$missing"
else
	ok "all ${#SCRIPT_PATHS[@]} script(s) source the shared lib's common.sh"
fi

# 6. no cleanup trap on EXIT in executable code
if hits="$(code_lines | grep -E 'trap[[:space:]].*[[:space:]]EXIT' || true)"; [ -n "$hits" ]; then
	fail "cleanup trap(s) on EXIT — on bash 3.2 the trap's status becomes the script's, laundering an abort into exit 0 (#4476):"
	printf '  %s\n' "$hits"
else
	ok "no cleanup trap on EXIT in any extracted script (#4476, class #4479)"
fi

# 7. every conditionally-built array is non-empty by construction or length-guarded
arr_bad=0
for f in "${SCRIPT_PATHS[@]}"; do
	while IFS= read -r arr; do
		[ -n "$arr" ] || continue
		# non-empty by construction: its declaring assignment carries at least one element
		grep -qE "^[[:space:]]*${arr}=\([^)]" "$f" && continue
		grep -qE "\\\$\{#${arr}\[@\]\}" "$f" && continue
		fail "$f: \"\${${arr}[@]}\" may expand an EMPTY array under set -u on bash 3.2 — declare it non-empty or length-guard it"
		arr_bad=1
	done < <(sed -e 's/#.*$//' "$f" | grep -oE '\$\{[A-Za-z_][A-Za-z0-9_]*\[@\]\}' | sed -E 's/^\$\{([A-Za-z_][A-Za-z0-9_]*)\[@\]\}$/\1/' | LC_ALL=C sort -u)
done
[ "$arr_bad" = 0 ] && ok "every \"\${arr[@]}\" expansion is non-empty by construction or length-guarded (bash 3.2 + set -u)"

# 8. a shim miss is 127 with EMPTY stdout — probed live on the shared primitive, network-free
probe_out="$(CLAUDE_PLUGIN_ROOT=/nonexistent-kampus-plugin-root bash -c '
	set -uo pipefail
	. "'"$SKILLS_DIR"'/../lib/common.sh"
	kp_pcli
' 2>/dev/null)"
probe_rc=$?
probe_bytes=$(printf '%s' "$probe_out" | wc -c | tr -d ' ')
if [ "$probe_rc" = 127 ] && [ "$probe_bytes" = 0 ]; then
	ok "kp_pcli under a bogus CLAUDE_PLUGIN_ROOT: exit=$probe_rc, stdout bytes=$probe_bytes — UNKNOWN, never an answer"
else
	fail "kp_pcli under a bogus CLAUDE_PLUGIN_ROOT: exit=$probe_rc, stdout bytes=$probe_bytes (want exit 127, 0 bytes)"
fi
pcli_bad=0
for f in "${SCRIPT_PATHS[@]}"; do
	grep -q 'kp_pcli' "$f" || continue
	grep -qE 'PCLI="\$\(kp_pcli\)" \|\| exit 127' "$f" && continue
	fail "$f: calls kp_pcli without \`|| exit 127\` — a could-not-run could fall through as an answer"
	pcli_bad=1
done
[ "$pcli_bad" = 0 ] && ok "every script that reaches a verb resolves it as PCLI=\"\$(kp_pcli)\" || exit 127"

# 9. a usage miss is non-zero with EMPTY stdout — asserted on BOTH operands, network-free
probed=0
usage_bad=0
for f in "${SCRIPT_PATHS[@]}"; do
	grep -qE '^\[ "\$#" -ge [0-9]+ \] \|\|' "$f" || continue
	probed=$((probed + 1))
	out="$(bash "$f" 2>/dev/null)"
	rc=$?
	bytes=$(printf '%s' "$out" | wc -c | tr -d ' ')
	if [ "$rc" = 0 ] || [ "$bytes" != 0 ]; then
		fail "$(basename "$f") with no args: exit=$rc, stdout bytes=$bytes (want non-zero exit, 0 bytes)"
		usage_bad=1
	fi
done
if [ "$probed" -eq 0 ]; then
	fail "zero scope: no argument-taking script was probed for its usage refusal (ADR 0092)"
elif [ "$usage_bad" = 0 ]; then
	ok "all $probed argument-taking script(s) refuse a no-args call with a non-zero exit AND 0 bytes of stdout"
fi

echo "scanned scope: ${scanned_md} SKILL.md, ${scanned_sh} extracted script(s) across [${SKILLS[*]}]"
if [ "$errors" -gt 0 ]; then
	echo "verify-extraction: FAILED — $errors error(s)"
	exit 1
fi
echo "verify-extraction: OK — $checks checks over ${scanned_sh} script(s) in ${scanned_md} skill(s)"
