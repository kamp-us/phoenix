#!/usr/bin/env bash
# Regression coverage for #4508; extracts the workflow block so tests follow its code.
# The step runs under the runner's bash -e; fixture setup checks failures explicitly.
set -uo pipefail

die() { printf 'FAIL: fixture setup: %s\n' "$*" >&2; exit 1; }
ROOT=$(mktemp -d) || die "mktemp failed"
[ -n "$ROOT" ] && [ -d "$ROOT" ] || die "mktemp produced no directory"
trap 'rm -rf "$ROOT"' EXIT
HERE=$(cd "$(dirname "$0")" && pwd) || die "cannot resolve script directory"
WORKFLOW=${1:-"$HERE/leak-guard.yml"}
if [ ! -f "$WORKFLOW" ]; then
	echo "usage: $0 [path-to-leak-guard.yml]" >&2
	exit 2
fi
WORKFLOW_DIR=$(cd "$(dirname "$WORKFLOW")" && pwd) || die "cannot resolve workflow directory"
WORKFLOW="$WORKFLOW_DIR/$(basename "$WORKFLOW")"

ORIG="$ROOT/origin.git"
# file:// uses pack negotiation; local-path clones bypass shallow-history behavior.
FILEURL="file://$(cygpath -m "$ORIG" 2>/dev/null || echo "$ORIG")"
SEED="$ROOT/seed"
RUN="$ROOT/runner"
STUBS="$ROOT/stubs"
SCAN_LOG="$ROOT/scan.log"
OUT="$ROOT/out.txt"
PASS=0
FAIL=0

say() { printf '%s\n' "$*"; }
ok() {
	PASS=$((PASS + 1))
	say "PASS: $*"
}
bad() {
	FAIL=$((FAIL + 1))
	say "FAIL: $*"
}

# Stop at dedentation so the following job never becomes part of the shell block.
WORKFLOW_SCRIPT=$(awk '
	/^        run: \|$/ { on = 1; next }
	on && !(/^          / || /^$/) { exit }
	on { print substr($0, 11) }
' "$WORKFLOW") || die "cannot extract workflow block"
if [ -z "$WORKFLOW_SCRIPT" ]; then
	bad "could not extract the 'run: |' block from $WORKFLOW"
	exit 1
fi

if printf '%s\n' "$WORKFLOW_SCRIPT" | grep -q 'mapfile -t changed < <(git diff'; then
	bad "diff capture is a process substitution again — a failed git diff would be swallowed (#4508)"
else
	ok "diff capture is not a process substitution"
fi
if printf '%s\n' "$WORKFLOW_SCRIPT" | grep -q 'diff_raw=\$(git diff'; then
	ok "diff status is captured before use (fail-closed branch present)"
else
	bad "no 'if ! diff_raw=\$(git diff …)' capture — diff failures are unchecked"
fi
if printf '%s\n' "$WORKFLOW_SCRIPT" | grep -q -- '--depth=1 origin "$BASE_REF"'; then
	bad "PR-base fetch is --depth=1 again — an advanced main tip would be shallow-severed (#4508)"
else
	ok "PR-base fetch is not depth-limited"
fi

mkdir -p "$STUBS" || die "fixture command failed"
cat >"$STUBS/node" <<EOF || die "cannot write scanner stub"
#!/usr/bin/env bash
printf '%s\n' "SCAN: \$*" >> "$SCAN_LOG"
exit \${STUB_EXIT:-0}
EOF
REAL_GIT=$(command -v git) || die "cannot resolve fixture command"
{
	echo '#!/usr/bin/env bash'
	echo 'if [ "${1:-}" = diff ] && [ -n "${LG_KILL_DIFF:-}" ]; then'
	echo '  echo "fatal: simulated diff failure (LG_KILL_DIFF)" >&2'
	echo '  exit 128'
	echo 'fi'
	echo 'exec "'"$REAL_GIT"'" "$@"'
} >"$STUBS/git" || die "cannot write git stub"
chmod +x "$STUBS/node" "$STUBS/git" || die "fixture command failed"

git init -q --bare -b main "$ORIG" || die "fixture command failed"
git -C "$ORIG" config uploadpack.allowReachableSHA1InWant true || die "fixture command failed"
git clone -q "$FILEURL" "$SEED" || die "fixture command failed"
git -C "$SEED" config user.email t@t || die "fixture command failed"
git -C "$SEED" config user.name t || die "fixture command failed"
echo base >"$SEED/README.md" || die "fixture command failed"
git -C "$SEED" add . || die "fixture command failed"
git -C "$SEED" commit -qm base || die "fixture command failed"
git -C "$SEED" push -q origin main || die "fixture command failed"
T1=$(git -C "$SEED" rev-parse main) || die "fixture command failed"
git -C "$SEED" checkout -qb pr || die "fixture command failed"
echo a >"$SEED/a.md" || die "fixture command failed"
git -C "$SEED" add . || die "fixture command failed"
git -C "$SEED" commit -qm "add a.md" || die "fixture command failed"
echo b >>"$SEED/README.md" || die "fixture command failed"
git -C "$SEED" commit -qam "touch README" || die "fixture command failed"
git -C "$SEED" push -q origin pr || die "fixture command failed"
git clone -q "$FILEURL" "$RUN" || die "fixture command failed"
git -C "$RUN" config user.email t@t || die "fixture command failed"
git -C "$RUN" config user.name t || die "fixture command failed"
# The runner must first learn T2 from the workflow fetch.
git -C "$SEED" checkout -q main || die "fixture command failed"
echo c >"$SEED/c.md" || die "fixture command failed"
git -C "$SEED" add . || die "fixture command failed"
git -C "$SEED" commit -qm "main-only c" || die "fixture command failed"
git -C "$SEED" push -q origin main || die "fixture command failed"
T2=$(git -C "$SEED" rev-parse main) || die "fixture command failed"
[ "$T2" != "$T1" ] || die "main did not advance"

build_merge() {
	# Fetch only the PR branch, leaving the advanced main unseen by the runner.
	git -C "$RUN" fetch -q origin "$1" || die "fixture command failed"
	git -C "$RUN" checkout -q --detach "$T1" || die "fixture command failed"
	git -C "$RUN" merge -q --no-ff -m "Merge $1 into $T1" "origin/$1" || die "fixture command failed"
}

run_step() { # $1 = script; remaining args = VAR=value pairs; output → $OUT; echoes rc
	script=$1
	shift
	(
		cd "$RUN" &&
			env PATH="$STUBS:$PATH" "$@" bash -e <<<"$script"
	) >"$OUT" 2>&1
	echo $?
}
scans() { awk 'END{print NR}' "$SCAN_LOG" 2>/dev/null; }
shallow_lines() {
	awk 'END{print NR}' "$RUN/.git/shallow" 2>/dev/null || echo 0
}
: >"$SCAN_LOG" || die "fixture command failed"

build_merge pr
if git -C "$RUN" cat-file -e "$T2^{commit}" 2>/dev/null; then
	die "runner already knows the advanced main before workflow fetch"
fi
before=$(shallow_lines)
rc=$(run_step "$WORKFLOW_SCRIPT" "BASE_REF=main" "MERGE_GROUP_BASE_SHA=")
n=$(scans)
after=$(shallow_lines)
if [ "$rc" -eq 0 ] && [ "$n" -eq 1 ] && grep -q "Scanning 2 changed" "$OUT"; then
	ok "advancing main: base fetched full, diff resolved, scanner ran on both PR files (exit 0)"
else
	bad "advancing main: rc=$rc scans=$n"; sed -n '1,12p' "$OUT"
fi
if [ "$before" = "$after" ]; then
	ok "advancing main: the base fetch added no .git/shallow entry ($after entries) — no severance"
else
	bad "advancing main: .git/shallow grew $before -> $after — the fetch is still depth-limited"
fi

STUB_EXIT=12
rc=$(run_step "$WORKFLOW_SCRIPT" "BASE_REF=main" "MERGE_GROUP_BASE_SHA=" "STUB_EXIT=$STUB_EXIT")
if [ "$rc" -eq 12 ]; then
	ok "scanner exit 12 propagates: step exits 12 (fail closed on a leak)"
else
	bad "scanner exit 12: expected step rc=12, got rc=$rc"
fi
STUB_EXIT=1
rc=$(run_step "$WORKFLOW_SCRIPT" "BASE_REF=main" "MERGE_GROUP_BASE_SHA=" "STUB_EXIT=$STUB_EXIT")
if [ "$rc" -eq 1 ]; then
	ok "scanner exit 1 propagates: step exits 1"
else
	bad "scanner exit 1: expected step rc=1, got rc=$rc"
fi
unset STUB_EXIT

rc=$(run_step "$WORKFLOW_SCRIPT" "BASE_REF=main" "MERGE_GROUP_BASE_SHA=" "LG_KILL_DIFF=1")
if [ "$rc" -eq 1 ] && grep -q "::error::git diff" "$OUT"; then
	ok "forced git-diff failure: step exits 1 with ::error — no clean scan over an unreadable diff"
else
	bad "forced diff failure: rc=$rc"; sed -n '1,12p' "$OUT"
fi

: >"$SCAN_LOG" || die "fixture command failed"
rc=$(run_step "$WORKFLOW_SCRIPT" "BASE_REF=" "MERGE_GROUP_BASE_SHA=$T1")
n=$(scans)
if [ "$rc" -eq 0 ] && [ "$n" -eq 1 ] && grep -q "Scanning 2 changed" "$OUT"; then
	ok "merge_group: batch base fetched by SHA, scanner ran on both PR files"
else
	bad "merge_group: rc=$rc scans=$n"; sed -n '1,12p' "$OUT"
fi

: >"$SCAN_LOG" || die "fixture command failed"
rc=$(run_step "$WORKFLOW_SCRIPT" "BASE_REF=" "MERGE_GROUP_BASE_SHA=")
n=$(scans)
if [ "$rc" -eq 0 ] && [ "$n" -eq 1 ] && grep -q "Scanning 2 changed" "$OUT"; then
	ok "workflow_dispatch: else arm resolves main, scanner ran on both PR files"
else
	bad "workflow_dispatch: rc=$rc scans=$n"; sed -n '1,12p' "$OUT"
fi

git -C "$SEED" checkout -qb empty-pr "$T1" || die "fixture command failed"
git -C "$SEED" commit -q --allow-empty -m "no-op" || die "fixture command failed"
git -C "$SEED" push -q origin empty-pr || die "fixture command failed"
build_merge empty-pr
: >"$SCAN_LOG" || die "fixture command failed"
rc=$(run_step "$WORKFLOW_SCRIPT" "BASE_REF=" "MERGE_GROUP_BASE_SHA=")
n=$(scans)
if [ "$rc" -eq 0 ] && grep -q "No changed files" "$OUT" && [ "$n" -eq 0 ]; then
	ok "legitimate empty diff: clean exit 0, scanner correctly skipped"
else
	bad "legitimate empty diff: rc=$rc scans=$n"; sed -n '1,12p' "$OUT"
fi

say ""
say "RESULTS: $PASS passed, $FAIL failed ($WORKFLOW)"
[ "$FAIL" -eq 0 ]
