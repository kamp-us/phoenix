#!/usr/bin/env bash
# Executable pin for kp_skill_shell_surfaces' scan-status contract (#4487). Run it directly:
#   bash claude-plugins/kampus-pipeline/skills/shared/lib/common-test.sh
#
# `set -uo pipefail` WITHOUT `-e`, and no EXIT trap: on bash 3.2 a `-u` abort under `-e` reaches
# an EXIT trap with `$?` already 0, so the script would exit 0 having aborted (#4479). Cleanup is
# explicit at each exit instead.
set -uo pipefail

lib="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"
# shellcheck source=./common.sh
. "$lib"

failures=0
fail() { printf 'FAIL: %s\n' "$*"; failures=$((failures + 1)); }
ok() { printf 'ok: %s\n' "$*"; }

tmp="$(mktemp -d)" || { printf 'FAIL: could not create a temp fixture dir\n'; exit 1; }
cleanup() { chmod -R u+rwx "$tmp" 2>/dev/null; rm -rf "$tmp"; }

# Fixture: a complete skill (SKILL.md + two *.sh at two depths) and an empty one.
mkdir -p "$tmp/skills/complete/scripts" "$tmp/skills/empty"
printf 'x\n' > "$tmp/skills/complete/SKILL.md"
printf 'x\n' > "$tmp/skills/complete/top.sh"
printf 'x\n' > "$tmp/skills/complete/scripts/nested.sh"

# 1. Complete surface: every file, sorted, exit 0.
out="$(kp_skill_shell_surfaces "$tmp/skills" complete)"; rc=$?
expected="$tmp/skills/complete/SKILL.md
$tmp/skills/complete/scripts/nested.sh
$tmp/skills/complete/top.sh"
if [ "$rc" -eq 0 ] && [ "$out" = "$expected" ]; then
	ok "complete surface resolves every file, sorted, exit 0"
else
	fail "complete surface: rc=$rc out=[$out]"
fi

# 2. Empty surface is a FACT, not an error: exit 0, nothing on stdout.
out="$(kp_skill_shell_surfaces "$tmp/skills" empty 2>/dev/null)"; rc=$?
if [ "$rc" -eq 0 ] && [ -z "$out" ]; then
	ok "empty skill directory: exit 0, no output (the contract is preserved)"
else
	fail "empty skill directory: rc=$rc out=[$out]"
fi

# 3. Absent skill directory: same fact, same exit 0.
out="$(kp_skill_shell_surfaces "$tmp/skills" no-such-skill 2>/dev/null)"; rc=$?
if [ "$rc" -eq 0 ] && [ -z "$out" ]; then
	ok "absent skill directory: exit 0, no output"
else
	fail "absent skill directory: rc=$rc out=[$out]"
fi

# 4. THE PIN: a PARTIALLY failing find must not yield a narrowed surface. An unreadable
# subdirectory makes find exit non-zero while still printing the entries it could read.
chmod 000 "$tmp/skills/complete/scripts"
find "$tmp/skills/complete" -type f -name '*.sh' >/dev/null 2>&1
find_rc=$?
if [ "$find_rc" -eq 0 ]; then
	# Running as root (or on a filesystem that ignores the mode) — the fixture did not take, so
	# this case was never exercised. UNKNOWN is not a pass: red, do not skip.
	fail "fixture did not take: find still exits 0 over an unreadable subdirectory (running as root?) — the narrowing case was NOT exercised"
else
	err="$tmp/stderr"
	out="$(kp_skill_shell_surfaces "$tmp/skills" complete 2>"$err")"; rc=$?
	diag="$(cat "$err")"
	if [ "$rc" -eq 0 ]; then
		fail "failed find returned 0 — the pipeline status is being discarded (#4487)"
	elif [ -n "$out" ]; then
		fail "failed find emitted a narrowed surface [$out] — it must emit nothing"
	elif [ -z "$diag" ]; then
		fail "failed find returned $rc with an empty stderr — non-zero with no diagnostic is itself a fail-open"
	else
		ok "failed find: exit $rc, empty stdout, diagnostic on stderr"
	fi
fi
chmod 755 "$tmp/skills/complete/scripts"

cleanup
if [ "$failures" -ne 0 ]; then
	printf '\ncommon-test: %d failure(s)\n' "$failures"
	exit 1
fi
printf '\ncommon-test: all checks passed\n'
