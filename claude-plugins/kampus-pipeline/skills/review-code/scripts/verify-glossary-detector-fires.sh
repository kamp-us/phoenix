#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC2016
# SC2016 is declared, not waved off: the mutant generators' sed programs are LITERAL awk text —
# expanding their `$0` / `$` here would rewrite the mutants into something else.
# Reviewer-runnable proof that glossary-freshness's detector (3) CAN FIRE, and that a detector which
# could not run reaches CANNOT-EVALUATE rather than the clean skip (#4700).
#
# Detector (3) — a new public export added to an EXISTING package's entry point — shipped born-dead
# on 2026-06-20 and stayed that way for six weeks. Every sighting of it was of the SKIP path, which
# is the whole problem: a detector that can never match is invisible to any suite that only asserts
# the happy `not applicable` line. So the property under test is POSITIVE — feed it a diff that does
# add a public export and require a match — plus the loudness contract on the other side: an unrun
# detector must be CANNOT-EVALUATE, never a plausible empty answer.
#
# A read that could not SEE is the second property, and it is the same shape one branch over (#4986):
# three reads used to resolve a failure or an empty result to the clean skip. Each now routes through
# `cannot()`, and each is driven here by a fixture that forces exactly that could-not-see state — an
# unreadable base tree, an exit-0-but-empty file list, an exit-0-but-empty diff.
#
# Falsifiability is asserted, not assumed. The harness generates eight MUTANTS, each reverting one
# claim this fix rests on, and requires the assertions to go red under each:
#   M1  the awk regex literal comes back        → positive fixture must go LOUD, not green
#   M2  detector (3)'s loudness is deleted      → an unrun detector must fall through to the skip
#   M3  M1 + M2, i.e. the code as filed         → reproduces #4700: a clean skip
#   M4  `\b` comes back as the word boundary    → one-true-awk does not implement it, so no match
#   M5  the added-line test and the export test fuse back into one `^\+[^+].*export` regex, where
#       the `[^+]` eats the `e` of an unindented `+export` before `.*export` can match
#   M6  the empty-diff scope assert is deleted  → an empty diff must fall through to the skip
#   M7  the empty-file-list assert is deleted   → an empty file list must fall through to the skip
#   M8  the base-tree assert is deleted         → an unreadable base must read as "no .glossary"
# M4 and M5 pin two further deaths found while fixing the filed one: with the character class
# repaired and nothing else changed, this detector STILL matched nothing. M5 is also why the added-
# line test and the export test are two separate patterns rather than one — split, `[^+]` is
# harmless; fused, it silently drops the commonest shape of the surface the detector exists to see.
# M6–M8 are the #4986 half: each deletes exactly one guard and requires the deleted guard's own
# could-not-see fixture to reach a `not applicable` skip again.
#
# M1 and M3 do not reproduce the filed regex byte-for-byte: the `sed` generator consumes the
# backslashes, so what lands is the UNESCAPED form of it. That is still unparseable to one-true-awk
# for the same reason (a `/` inside a bracket expression closes the regex literal), so the property
# under test — an unparseable program must go loud — is pinned either way.
#
# Hermetic: `gh`, `git` and the CLI shim are stubbed, so this needs no auth, no network, and reads
# no real PR.
#
# Usage:  bash claude-plugins/kampus-pipeline/skills/review-code/scripts/verify-glossary-detector-fires.sh
#
# Shell shape per .patterns/skill-script-shell-shape.md: `set -uo pipefail`, never `-e`, and no
# `EXIT` trap — on bash 3.2 `-e` plus a cleanup trap launders a `set -u` abort into exit 0, and this
# harness's whole contract is its exit status.
set -uo pipefail

# PHYSICAL resolution (`cd -P` / `pwd -P`), unlike the sibling verify scripts: CI invokes this
# through the `.claude/skills` symlink, and the `$DIR/../..` hop below has to land on the plugin
# root. Resolved logically, `..` is folded textually and that hop lands on `.claude/`, where there
# is no `lib/` — the mutants then all die at repo resolution, which is a CANNOT-EVALUATE too and so
# scores as "mutant caught" while testing nothing.
DIR="$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd -P)"
SUT="$DIR/glossary-freshness.sh"
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
HEAD="$TMP/head"
mkdir -p "$BIN" "$PLUGIN" "$HEAD" || { echo "FAIL: cannot create the stub dirs under $TMP"; exit 1; }
# Every case runs the SUT for PR 1, so the handle must be PR 1's — `HANDLE_PR` plus the PR-stamped
# worktree/ref names a real materialization writes. Without them `head-env.sh` refuses the handle as
# possibly a sibling reviewer's, which is the fail-closed behaviour #5416 added.
printf 'BASE_REF=main\nHEAD_SHA=%s\nHANDLE_PR=1\nREVIEW_WT=%s\nPR_REF=refs/pr/1-proof\n' \
	"0000000000000000000000000000000000000000" "$TMP/review-head-1-proof" > "$HEAD/head.env"

cat > "$BIN/gh" <<'STUB'
#!/usr/bin/env bash
# FAIL and EMPTY are two DIFFERENT stub modes, because the defect under test is exactly their
# conflation: FAIL exits non-zero, EMPTY exits 0 with nothing on stdout (#4986).
case "$1 ${2:-}" in
  "pr diff")        [ "$STUB_DIFF"  = FAIL ] && exit 1; [ "$STUB_DIFF"  = EMPTY ] && exit 0; cat "$STUB_DIFF";  exit 0 ;;
  "api --paginate") [ "$STUB_FILES" = FAIL ] && exit 1; [ "$STUB_FILES" = EMPTY ] && exit 0; cat "$STUB_FILES"; exit 0 ;;
esac
exit 0
STUB

# Every path EXISTS on base except when the case says otherwise, so detectors (1) and (2) stay mute
# and detector (3) is the only one that can speak — which is what isolates it under test.
# `STUB_BASE=FAIL` is the unreadable-base mode: `cat-file` fails on EVERY path, which is what makes
# "the base could not be read" indistinguishable from "the path is absent" without the tree assert.
cat > "$BIN/git" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  cat-file) [ "${STUB_BASE:-ok}" = FAIL ] && exit 1; exit 0 ;;
  ls-tree)  if [ "$2" = "-r" ]; then printf 'kit/package.json\nui/package.json\n'
            else printf 'sozluk\npano\n'; fi
            exit 0 ;;
esac
exit 0
STUB

cat > "$PLUGIN/pipeline-cli" <<'STUB'
#!/usr/bin/env bash
case "$1 ${2:-}" in
  "scratchpad path") printf '%s\n' "$STUB_HEAD_DIR" ;;
esac
exit 0
STUB
chmod +x "$BIN/gh" "$BIN/git" "$PLUGIN/pipeline-cli"

# --- the fixtures ---------------------------------------------------------------------------------
# POSITIVE: an existing package's entry point gains a public export. Unindented on purpose — that is
# the shape M5's `[^+]` guard silently drops.
cat > "$TMP/diff-export-added" <<'EOF'
diff --git a/packages/kit/src/index.ts b/packages/kit/src/index.ts
--- a/packages/kit/src/index.ts
+++ b/packages/kit/src/index.ts
@@ -1,1 +1,2 @@
 export const existing = 1;
+export const freshlyExposed = 2;
EOF

# NEGATIVE: the same entry point is touched, but nothing public is exposed.
cat > "$TMP/diff-no-export" <<'EOF'
diff --git a/packages/kit/src/index.ts b/packages/kit/src/index.ts
--- a/packages/kit/src/index.ts
+++ b/packages/kit/src/index.ts
@@ -1,1 +1,2 @@
 export const existing = 1;
+const internalHelper = 2;
EOF

# NEGATIVE: an export is added, but not on a public entry point — the detector's scope, not its blindness.
cat > "$TMP/diff-export-off-entry" <<'EOF'
diff --git a/packages/kit/src/internal.ts b/packages/kit/src/internal.ts
--- a/packages/kit/src/internal.ts
+++ b/packages/kit/src/internal.ts
@@ -1,0 +1,1 @@
+export const notAnEntryPoint = 1;
EOF

printf 'modified\tpackages/kit/src/index.ts\n' > "$TMP/files-plain"
printf 'modified\tpackages/kit/src/index.ts\nmodified\t.glossary/TERMS.md\n' > "$TMP/files-glossary-touched"

# One case = one run of the script under one PR shape. `$OUT` is its stdout, `$RC` its exit status.
run_case() {   # $1 = script, $2 = diff fixture (or FAIL|EMPTY), $3 = files fixture (or FAIL|EMPTY), $4 = base (ok|FAIL)
	OUT="$(STUB_DIFF="$2" STUB_FILES="$3" STUB_BASE="${4:-ok}" STUB_HEAD_DIR="$HEAD" \
		CLAUDE_PIPELINE_REPO=owner/repo CLAUDE_PLUGIN_ROOT="$TMP/plugin" \
		PATH="$BIN:$PATH" bash "$1" 1 2>"$TMP/err")"
	RC=$?
}

check() {   # $1 = label, $2 = expected stdout substring, $3 = zero|nonzero
	if ! printf '%s' "$OUT" | grep -q "$2"; then
		printf 'BAD   %-38s stdout missing %-34s got: %s\n' "$1" "$2" "${OUT:-<empty>}"
		fail=1
		return
	fi
	if [ "$3" = nonzero ] && [ "$RC" -eq 0 ]; then
		printf 'BAD   %-38s CANNOT-EVALUATE must exit non-zero, exited 0\n' "$1"
		fail=1
		return
	fi
	if [ "$3" = zero ] && [ "$RC" -ne 0 ]; then
		printf 'BAD   %-38s expected exit 0, exited %s\n' "$1" "$RC"
		fail=1
		return
	fi
	printf 'OK    %-38s %s\n' "$1" "$2"
}

echo "scope: $SUT, driven under 9 PR shapes + 8 mutants"

# --- the POSITIVE fixture: detector (3) fires, and the gate reaches the new-surface branch ---------
run_case "$SUT" "$TMP/diff-export-added" "$TMP/files-plain"
check "added export ⇒ new surface" "scanned new surfaces" zero
check "added export ⇒ FAIL, no TERMS touch" "FAIL — new surface added" zero
run_case "$SUT" "$TMP/diff-export-added" "$TMP/files-glossary-touched"
check "added export + TERMS touch ⇒ PASS" "PASS — new surface ships with" zero

# --- the NEGATIVE fixtures: the skip is still reached when nothing public was added ----------------
run_case "$SUT" "$TMP/diff-no-export" "$TMP/files-plain"
check "no export added ⇒ skip" "not applicable — no new feature folder" zero
run_case "$SUT" "$TMP/diff-export-off-entry" "$TMP/files-plain"
check "export off the entry point ⇒ skip" "not applicable — no new feature folder" zero

# --- could-not-run is LOUD, and is not the skip ---------------------------------------------------
run_case "$SUT" FAIL "$TMP/files-plain"
check "diff unreadable ⇒ CANNOT-EVALUATE" "CANNOT-EVALUATE (detector (3)" nonzero
run_case "$SUT" "$TMP/diff-export-added" FAIL
check "file list unreadable ⇒ CANNOT-EVAL" "CANNOT-EVALUATE (the PR file list" nonzero

# --- and a read that SUCCEEDED while seeing nothing is could-not-see too, not a clean answer (#4986)
run_case "$SUT" EMPTY "$TMP/files-plain"
check "empty diff at exit 0 ⇒ CANNOT-EVAL" "EMPTY diff at exit 0" nonzero
run_case "$SUT" "$TMP/diff-no-export" EMPTY
check "empty file list ⇒ CANNOT-EVALUATE" "came back EMPTY at exit 0" nonzero
run_case "$SUT" "$TMP/diff-no-export" "$TMP/files-plain" FAIL
check "unreadable base ⇒ CANNOT-EVALUATE" "the base tree origin/main is unreadable" nonzero

# --- falsifiability: every claim above must go red under a mutant that reverts it ------------------
#
# A mutant must live at the SAME depth as the original: the script resolves its shared lib and its
# head handle through `../../../lib` and its own directory, so a mutant dropped in a flat temp dir
# dies at repo resolution — which is a CANNOT-EVALUATE too, and would let a loose assertion score
# the mutant as caught for entirely the wrong reason. Hence a mirrored tree, and hence every
# expectation below naming its outcome precisely rather than matching CANNOT-EVALUATE at large.
PLUGIN_SRC="$(CDPATH= cd -- "$DIR/../../.." && pwd)"
MUT_DIR="$TMP/tree/skills/review-code/scripts"
mkdir -p "$MUT_DIR" || { echo "FAIL: cannot create the mutant tree under $TMP"; exit 1; }
ln -s "$PLUGIN_SRC/lib" "$TMP/tree/lib" || { echo "FAIL: cannot mirror the shared lib"; exit 1; }
ln -s "$DIR/head-env.sh" "$MUT_DIR/head-env.sh" || { echo "FAIL: cannot mirror head-env.sh"; exit 1; }

LITERAL='/^\+\+\+ b\/packages\/[^/]+\/src\/index\.(ts|tsx)$/ { in_entry = 1; next }'
mutate() {   # $1 = name, $2… = sed programs
	local name="$1"; shift
	MUTANT="$MUT_DIR/mutant-$name.sh"
	cp "$SUT" "$MUTANT"
	for prog in "$@"; do
		sed "$prog" "$MUTANT" > "$MUTANT.tmp" && mv "$MUTANT.tmp" "$MUTANT"
	done
	if cmp -s "$SUT" "$MUTANT"; then
		printf 'BAD   %-38s the mutant is byte-identical to the original — it reverts nothing\n' "$name"
		fail=1
		return 1
	fi
	return 0
}

expect_mutant() {   # $1 = name, $2 = substring the BROKEN behaviour prints, $3 = why it has teeth
	if printf '%s' "$OUT" | grep -q "$2"; then
		printf 'OK    %-38s %s\n' "$1" "$3"
	else
		printf 'BAD   %-38s expected the reverted behaviour %s, got: %s\n' "$1" "$2" "${OUT:-<empty>}"
		fail=1
	fi
}

if mutate regex "s%^\$0 ~ entry.*%$LITERAL%"; then
	run_case "$MUTANT" "$TMP/diff-export-added" "$TMP/files-plain"
	expect_mutant "M1 regex literal returns" "CANNOT-EVALUATE (detector (3)" "the born-dead regex now goes LOUD, not green"
fi

# Detector (3)'s loudness is now three lines, not one — the two status tests plus the scope assert —
# so reproducing the historic silent skip takes all three. M6 below isolates the scope assert alone.
if mutate status '/DETECTOR3_RC/d' '/DETECTOR3_AWK_RC/d' '/EMPTY diff at exit 0/d'; then
	run_case "$MUTANT" FAIL "$TMP/files-plain"
	expect_mutant "M2 detector (3) loudness deleted" "not applicable" "without them an unrun detector reads as a clean skip"
fi

if mutate asfiled "s%^\$0 ~ entry.*%$LITERAL%" '/DETECTOR3_RC/d' '/DETECTOR3_AWK_RC/d' '/EMPTY diff at exit 0/d'; then
	run_case "$MUTANT" "$TMP/diff-export-added" "$TMP/files-plain"
	expect_mutant "M3 the code as filed (#4700)" "not applicable" "reproduces the filed defect: a clean skip over a real new export"
fi

if mutate wordboundary 's%^  expre = .*%  expre = "\\\\bexport\\\\b"%'; then
	run_case "$MUTANT" "$TMP/diff-export-added" "$TMP/files-plain"
	expect_mutant "M4 \\b as the boundary" "not applicable" "one-true-awk has no \\b, so the detector matches nothing"
fi

if mutate addedline 's%^in_entry .*%in_entry \&\& /^\\+[^+].*export/ { print }%'; then
	run_case "$MUTANT" "$TMP/diff-export-added" "$TMP/files-plain"
	expect_mutant "M5 one combined added-line regex" "not applicable" "[^+] eats the e of an unindented +export before .*export can match"
fi

# M6–M8: one guard deleted each, driven by that guard's own could-not-see fixture. Each must land
# back on a `not applicable` skip — which is the behaviour #4986 filed, and the teeth of the three
# assertions above.
if mutate emptydiff '/EMPTY diff at exit 0/d'; then
	run_case "$MUTANT" EMPTY "$TMP/files-plain"
	expect_mutant "M6 empty-diff assert deleted" "not applicable" "an empty diff reads as 'this PR added no export'"
fi

if mutate emptyfiles '/came back EMPTY at exit 0/d'; then
	run_case "$MUTANT" "$TMP/diff-no-export" EMPTY
	expect_mutant "M7 empty-file-list assert deleted" "not applicable" "an empty file list reads as 'this PR added no new surface'"
fi

if mutate basetree '/the base tree origin/d'; then
	run_case "$MUTANT" "$TMP/diff-no-export" "$TMP/files-plain" FAIL
	expect_mutant "M8 base-tree assert deleted" "no .glossary/TERMS.md on base" "an unreadable base reads as a repo that never adopted the glossary"
fi

rm -rf "$TMP"
if [ "$fail" -ne 0 ]; then
	echo "FAIL: glossary-freshness detector (3) does not fire, or a could-not-run reads as a skip"
	exit 1
fi
echo "PASS: detector (3) fires on an added public export, skips when none, and goes CANNOT-EVALUATE when it cannot run"
