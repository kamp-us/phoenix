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
#   1. INVOCATION-ONLY — every fenced bash/sh block left in each SKILL.md carries only sanctioned
#      non-glue lines (comments, blanks and trailing `\` continuations allowed); no multi-line glue
#      remains. The sanctioned shapes are epic #4435 / child #4454's AC4 list as recorded in the
#      epic ledger — a skill-local script executed by path (anywhere under `skills/<skill>/`, not
#      only `scripts/`), a `pipeline-cli` verb call (the path-resolved shim, literal or via a
#      resolved `"$PCLI"`), the shim-resolution assignment, an operator placeholder assignment
#      (`NAME=<placeholder>`) that supplies one, and a heredoc body fed to a recognized invocation.
#      The recognizer lives in `check1-invocation.awk`; #4587 is why it is that wide, and why the
#      fix belongs here and never in the corpus it judges.
#   1a. RECOGNIZER SELF-TEST — check 1's classifier, run over fixture blocks that pin BOTH
#      directions: every sanctioned shape is accepted, AND a multi-line gh/jq pipeline still reds.
#      A widening that greens everything is a failure, so the harness re-proves it didn't on every
#      run rather than asserting it in prose (#4587 AC3).
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
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SELF="$SCRIPT_DIR/$(basename -- "${BASH_SOURCE[0]}")"
CHECK1_AWK="$SCRIPT_DIR/check1-invocation.awk"
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

# 1a. the recognizer self-test — the SAME awk check 1 runs, over fixtures that pin both directions
[ -f "$CHECK1_AWK" ] || {
	fail "check 1's recognizer is missing at $CHECK1_AWK — refusing to report a pass over nothing (ADR 0092)"
	echo "verify-extraction: FAILED — $errors error(s)"
	exit 1
}
c1_cases=0
c1_bad=0
c1_case() {   # <name> <ok|red>; the fixture's fenced block arrives on stdin
	local name="$1" expect="$2" tmp out verdict
	tmp="$(mktemp)" || { fail "check 1 self-test '$name': could not allocate a fixture"; c1_bad=1; return; }
	cat > "$tmp"
	out="$(awk -v skill="$name" -f "$CHECK1_AWK" "$tmp")"
	rm -f "$tmp"
	verdict=ok
	[ -n "$out" ] && verdict=red
	c1_cases=$((c1_cases + 1))
	[ "$verdict" = "$expect" ] && return
	fail "check 1 self-test '$name': recognizer said $verdict, expected $expect"
	[ -n "$out" ] && printf '%s\n' "$out"
	c1_bad=1
}

c1_case script-invocation ok <<'FIXTURE'
```bash
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/triage/scripts/dedup.sh" "$N"
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/triage/scripts/label.sh" "$N"
```
FIXTURE

c1_case skill-local-script-outside-scripts ok <<'FIXTURE'
```bash
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/report/footer.sh"
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/report/footer.sh" --short
```
FIXTURE

c1_case resolved-pcli-verb-call ok <<'FIXTURE'
```bash
PCLI="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/bin/pipeline-cli"
EXISTING=$("$PCLI" split-guard check \
  --parent <original #N> --title "<the split-child title>")
```
FIXTURE

c1_case literal-shim-verb-call ok <<'FIXTURE'
```bash
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/bin/pipeline-cli" decisions-index compact
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/bin/pipeline-cli" commands compact
```
FIXTURE

c1_case operator-placeholder-assignment ok <<'FIXTURE'
```bash
RUN=<run id>     # the failed run
PR=<n>           # the PR, if this is a PR run (else leave unset)
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/heal-ci/scripts/failed-logs.sh" "$RUN"
```
FIXTURE

c1_case heredoc-body-template ok <<'FIXTURE'
```bash
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/report/scripts/file-report.sh" \
  "<title>" <<'EOF'
## Summary
A body line that merely LOOKS like glue: gh api repos/o/r/issues | jq -r '.[].number'
EOF
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/report/footer.sh"
```
FIXTURE

c1_case solo-uncomposed-command ok <<'FIXTURE'
```bash
ls .decisions/NNNN-*.md   # -> .decisions/NNNN-real-slug.md, use exactly this filename
```
FIXTURE

c1_case multi-line-gh-jq-pipeline red <<'FIXTURE'
```bash
gh api "repos/$REPO/issues?state=open&per_page=100" \
  --jq '.[] | select(.assignee == null) | .number' | while read -r n; do
  gh api "repos/$REPO/issues/$n" --jq .title
done
```
FIXTURE

c1_case captured-gh-jq-assignment red <<'FIXTURE'
```bash
PRS=$(gh api "repos/$REPO/pulls?state=open" --jq '.[].number')
for p in $PRS; do echo "#$p"; done
```
FIXTURE

c1_case solo-composed-glue red <<'FIXTURE'
```bash
gh api "repos/$REPO/labels" --jq '.[].name' | sort
```
FIXTURE

c1_case verb-call-inside-a-pipeline red <<'FIXTURE'
```bash
PCLI="${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/bin/pipeline-cli"
gh pr diff "$PR" | grep '^+' | "$PCLI" leak-guard scan-comment
```
FIXTURE

c1_case solo-continued-command red <<'FIXTURE'
```bash
gh api "repos/$REPO/pulls?state=open&per_page=100" \
  --jq '.[] | select(.draft | not) | .number'
```
FIXTURE

# THE CLAMP GROUP — one fixture per accept clause's clamp, in classify() order, each pinning the
# REJECT side its clause's accept fixture cannot. Two rounds of review found a clause whose accept
# side alone was pinned (#4587 repair rounds 1 and 2), so the coverage rule is: mutate each clamp
# individually, and exactly one fixture here must flip.
#
# The second payload line of each is a SANCTIONED invocation, so the block's verdict turns on the
# first line alone — a glue partner would red the block for the wrong reason and the fixture would
# pass with its clamp disabled (the trap the first draft of these fixtures fell into).
c1_case script-invocation-heading-a-pipeline red <<'FIXTURE'
```bash
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/triage/scripts/dedup.sh" "$N" | jq -r '.[]'
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/triage/scripts/label.sh" "$N"
```
FIXTURE

# `verb-call-inside-a-pipeline` above pins the ANCHORING (a shim path buried mid-pipeline never
# matches at all), not this clamp — a verb call that HEADS the pipeline is what reaches it.
c1_case verb-call-heading-a-pipeline red <<'FIXTURE'
```bash
"$PCLI" verdict read --pr "$PR" --gate code | jq -r '._tag'
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/triage/scripts/dedup.sh" "$N"
```
FIXTURE

c1_case shim-resolution-with-pipeline red <<'FIXTURE'
```bash
PCLI="$(gh api "repos/$REPO/issues" --jq '.[].number' | sort -n | head -1)/bin/pipeline-cli"
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/triage/scripts/dedup.sh" "$N"
```
FIXTURE

c1_case placeholder-assignment-then-chain red <<'FIXTURE'
```bash
RUN=<run id> && gh run view "$RUN" --log-failed
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/heal-ci/scripts/failed-logs.sh" "$RUN"
```
FIXTURE

c1_case expansion-default-with-substitution red <<'FIXTURE'
```bash
NUMS="${CACHED_NUMS:-$(gh api "repos/$REPO/issues?state=open" --jq ".[].number" | sort -n | head -5)}"
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/triage/scripts/dedup.sh" "$NUMS"
```
FIXTURE

c1_case expansion-default-with-backtick red <<'FIXTURE'
```bash
NUMS="${CACHED_NUMS:-`gh api "repos/$REPO/issues?state=open" --jq ".[].number"`}"
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/triage/scripts/dedup.sh" "$NUMS"
```
FIXTURE

# The one fixture with NO sanctioned partner — both its lines are the offending class, because the
# defect IS that a trailing comment classifies the code. Still non-vacuous: it flips alone when
# decomment()'s strip is deleted.
c1_case comment-cannot-classify-the-code red <<'FIXTURE'
```bash
mkdir -p .decisions                                # per skills/adr/scripts/next-number.sh
cp .decisions/0000-template.md .decisions/NNNN.md  # per skills/adr/scripts/next-number.sh
```
FIXTURE

c1_case empty-block red <<'FIXTURE'
```bash
```
FIXTURE

if [ "$c1_bad" = 0 ]; then
	ok "check 1 recognizer self-test: $c1_cases fixture block(s) — every sanctioned shape accepted, glue still red"
fi

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

	# 1. every remaining fenced bash/sh block carries only sanctioned non-glue lines
	bad="$(awk -v skill="$skill" -f "$CHECK1_AWK" "$md")"
	if [ -n "$bad" ]; then
		fail "$skill/SKILL.md: fenced block(s) carry something other than a sanctioned invocation shape:"
		printf '%s\n' "$bad"
	else
		ok "$skill/SKILL.md: every fenced bash/sh block carries only sanctioned invocation shapes"
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
