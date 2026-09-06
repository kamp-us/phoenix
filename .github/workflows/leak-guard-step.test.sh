#!/usr/bin/env bash
# Regression tests for the `Scan PR diff for leaks` step in leak-guard.yml (#4508).
#
#   bash .github/workflows/leak-guard-step.test.sh [path-to-leak-guard.yml]
#
# The step's `run:` block is EXTRACTED from the workflow file (default: the repo's own)
# and executed against throwaway fixture repos, so the tests fail if the workflow drifts
# back into either defect shape:
#   - the diff capture reverts to a process substitution, which hides a failed `git diff`
#     from the runner's `bash -e` and reports a clean scan over a diff that never ran
#     (#4508; observed live 2026-09-06, run 34000979042);
#   - the PR-base fetch reverts to `--depth=1`, which shallow-grafts a main tip that
#     advanced since checkout and can leave the three-dot diff without a merge base.
#
# Fidelity notes: the extracted script is run under `bash -e` because that is GitHub's
# default shell for `run:` blocks — the environment the defects live in. This harness
# itself follows the repo shell shape (set -uo pipefail, never -e). The scanner is a PATH
# stub (`node`) that logs invocations and exits with $STUB_EXIT, so "the scanner ran" and
# "its exit code propagated" are observable. A second stub can force `git diff` to exit
# 128, the failure class the incident hit, deterministically on every git.
#
# Requires a real pack-protocol remote: fixtures talk to `file://` because a plain
# local-path remote hardlinks objects and skips shallow negotiation, which would hide
# the severance the tests are about.
set -uo pipefail

ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
HERE=$(cd "$(dirname "$0")" && pwd)
WORKFLOW=${1:-"$HERE/leak-guard.yml"}
if [ ! -f "$WORKFLOW" ]; then
	echo "usage: $0 [path-to-leak-guard.yml]" >&2
	exit 2
fi
WORKFLOW=$(cd "$(dirname "$WORKFLOW")" && pwd)/$(basename "$WORKFLOW")

ORIG="$ROOT/origin.git"
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

# ---------- extract the run block from the workflow ----------
# From the `run: |` marker, take exactly the block: lines at the block's 10-space base
# (or blanks), stopping at the first line dedented past it — a job appended after the
# step must not leak into the extracted script.
WORKFLOW_SCRIPT=$(awk '
	/^        run: \|$/ { on = 1; next }
	on && !(/^          / || /^$/) { exit }
	on { print substr($0, 11) }
' "$WORKFLOW")
if [ -z "$WORKFLOW_SCRIPT" ]; then
	bad "could not extract the 'run: |' block from $WORKFLOW"
	exit 1
fi

# shape pins: the two defect signatures must not come back
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

# ---------- stubs ----------
mkdir -p "$STUBS"
REAL_NODE=$(command -v node)
cat >"$STUBS/node" <<EOF
#!/usr/bin/env bash
printf '%s\n' "SCAN: \$*" >> "$SCAN_LOG"
exit \${STUB_EXIT:-0}
EOF
REAL_GIT=$(command -v git)
{
	echo '#!/usr/bin/env bash'
	echo 'if [ "${1:-}" = diff ] && [ -n "${LG_KILL_DIFF:-}" ]; then'
	echo '  echo "fatal: simulated diff failure (LG_KILL_DIFF)" >&2'
	echo '  exit 128'
	echo 'fi'
	echo 'exec "'"$REAL_GIT"'" "$@"'
} >"$STUBS/git"
chmod +x "$STUBS/node" "$STUBS/git"

# ---------- fixtures: origin, seed (authors), runner (the CI checkout) ----------
git init -q --bare -b main "$ORIG"
git -C "$ORIG" config uploadpack.allowReachableSHA1InWant true
git clone -q "$FILEURL" "$SEED"
git -C "$SEED" config user.email t@t
git -C "$SEED" config user.name t
echo base >"$SEED/README.md"
git -C "$SEED" add .
git -C "$SEED" commit -qm base
git -C "$SEED" push -q origin main
T1=$(git -C "$SEED" rev-parse main)
git -C "$SEED" checkout -qb pr
echo a >"$SEED/a.md"
git -C "$SEED" add .
git -C "$SEED" commit -qm "add a.md"
echo b >>"$SEED/README.md"
git -C "$SEED" commit -qam "touch README"
git -C "$SEED" push -q origin pr
git clone -q "$FILEURL" "$RUN"
git -C "$RUN" config user.email t@t
git -C "$RUN" config user.name t
# main advances to T2 AFTER the runner exists — the runner's first sighting of T2 is the
# step's own base fetch, exactly the CI incident's shape.
echo c >"$SEED/c.md"
git -C "$SEED" add .
git -C "$SEED" commit -qm "main-only c"
git -C "$SEED" push -q origin main
T2=$(git -C "$SEED" rev-parse main)

build_merge() { # $1 = PR branch; merges it into main@$T1 as a detached merge commit
	# (≙ refs/pull/N/merge). Fetches ONLY the PR branch: main@$T2 must stay unseen until
	# the step's own fetch, as on the runner.
	git -C "$RUN" fetch -q origin "$1"
	git -C "$RUN" checkout -q --detach "$T1"
	git -C "$RUN" merge -q --no-ff -m "Merge $1 into $T1" "origin/$1"
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
: >"$SCAN_LOG"

# ---------- C1: pull_request with advancing main — real scan, no severance ----------
build_merge pr
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

# ---------- C2: scanner failure propagates (leak found ⇒ exit 12; any failure ⇒ its code) ----------
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

# ---------- C3: diff failure fails closed ----------
rc=$(run_step "$WORKFLOW_SCRIPT" "BASE_REF=main" "MERGE_GROUP_BASE_SHA=" "LG_KILL_DIFF=1")
if [ "$rc" -eq 1 ] && grep -q "::error::git diff" "$OUT"; then
	ok "forced git-diff failure: step exits 1 with ::error — no clean scan over an unreadable diff"
else
	bad "forced diff failure: rc=$rc"; sed -n '1,12p' "$OUT"
fi

# ---------- C4: merge_group (batch base by SHA) ----------
: >"$SCAN_LOG"
rc=$(run_step "$WORKFLOW_SCRIPT" "BASE_REF=" "MERGE_GROUP_BASE_SHA=$T1")
n=$(scans)
if [ "$rc" -eq 0 ] && [ "$n" -eq 1 ] && grep -q "Scanning 2 changed" "$OUT"; then
	ok "merge_group: batch base fetched by SHA, scanner ran on both PR files"
else
	bad "merge_group: rc=$rc scans=$n"; sed -n '1,12p' "$OUT"
fi

# ---------- C5: workflow_dispatch ----------
: >"$SCAN_LOG"
rc=$(run_step "$WORKFLOW_SCRIPT" "BASE_REF=" "MERGE_GROUP_BASE_SHA=")
n=$(scans)
if [ "$rc" -eq 0 ] && [ "$n" -eq 1 ] && grep -q "Scanning 2 changed" "$OUT"; then
	ok "workflow_dispatch: else arm resolves main, scanner ran on both PR files"
else
	bad "workflow_dispatch: rc=$rc scans=$n"; sed -n '1,12p' "$OUT"
fi

# ---------- C6: legitimate empty diff — clean pass, scanner skipped ----------
git -C "$SEED" checkout -qb empty-pr "$T1"
git -C "$SEED" commit -q --allow-empty -m "no-op"
git -C "$SEED" push -q origin empty-pr
build_merge empty-pr
: >"$SCAN_LOG"
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
