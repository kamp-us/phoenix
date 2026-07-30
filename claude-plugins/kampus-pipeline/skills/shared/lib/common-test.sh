#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2016
# SC2016 is declared, not suppressed on principle: the fixtures below EMIT shell text, so the single
# quotes are the point — an expanded `${v#pre}` or `$dir` would write a different fixture than the
# one under test.
# Executable pin for kp_skill_shell_surfaces' scan-status contract (#4487) and for the source-edge
# surface widening + comment-stripped matching that ADR 0230 adds on top (#4541). Run it directly:
#   bash claude-plugins/kampus-pipeline/skills/shared/lib/common-test.sh
#
# Every case here is written to be FALSIFIABLE — each asserts a behaviour that the pre-ADR-0230
# resolver did not have, so the file goes red against the old one. A fixture that fails to take is
# reported RED, never skipped: an unexercised case is UNKNOWN, not a pass.
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

# Every function under test must EXIST before any case runs. A missing function exits 127 with a
# `command not found` on stderr — which FOUR of the cases below read as a correct fail-closed
# refusal (non-zero, empty stdout, a diagnostic on stderr) and report as a pass: the
# unreadable-surface, broken-edge, sibling-edge and non-idiom-source cases (measured by deleting
# this block and re-running). An unexercised case is UNKNOWN, not a pass, so refuse up front.
#
# The set is DERIVED from this file, never listed. A hardcoded list stops covering the moment a
# case reaches for a fourth function, silently reopening the exact 127 class this refusal closes —
# the same guard-in-text/absent-in-effect shape the rest of this suite pins. Derived from the RAW
# text on purpose: it over-includes (a name appearing only in a message string is still required to
# exist), and over-inclusion is the fail-closed direction. `kp__`-prefixed privates are excluded —
# nothing here calls them directly. An empty derivation means this file could not be read, which is
# UNKNOWN, never "no functions to check".
required_fns="$(grep -oE 'kp_[a-z][a-z0-9_]*' "${BASH_SOURCE[0]}" | LC_ALL=C sort -u)"
if [ -z "$required_fns" ]; then
	printf 'FAIL: could not derive the exercised function set from %s — refusing to run cases whose 127 would read as a fail-closed pass.\n' "${BASH_SOURCE[0]}"
	exit 1
fi
missing=0
while IFS= read -r fn; do
	[ -n "$fn" ] || continue
	if ! type "$fn" >/dev/null 2>&1; then
		printf 'FAIL: %s is not defined by %s — the cases below would resolve 127 and read as fail-closed passes. Refusing to run them.\n' "$fn" "$lib"
		missing=$((missing + 1))
	fi
done <<EOF
$required_fns
EOF
if [ "$missing" -ne 0 ]; then
	exit 1
fi
if [ -z "${KP_EDGE_MAX_HOPS:-}" ]; then
	printf 'FAIL: KP_EDGE_MAX_HOPS is not set by %s — the hop-cap case cannot be exercised.\n' "$lib"
	exit 1
fi

tmp="$(mktemp -d)" || { printf 'FAIL: could not create a temp fixture dir\n'; exit 1; }
# PHYSICAL, because the edge resolver answers in physical paths and `mktemp -d` hands back a logical
# one on macOS (/var → /private/var). Comparing its answer against a logical fixture path would fail
# for a path-shape reason and say nothing about the behaviour under test.
tmp="$(cd -P "$tmp" && pwd)" || { printf 'FAIL: could not resolve the temp fixture dir physically\n'; exit 1; }
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

# ---------------------------------------------------------------------------------------------
# ADR 0230 / #4541 — comment-stripped matching and the source-edge surface widening.
# ---------------------------------------------------------------------------------------------

# The documented sourcing idiom, built here rather than pasted, so a fixture cannot drift from the
# matcher by a stray character. `%s` twice: the relative directory and the file name.
idiom() { printf '. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/%s" && pwd)/%s"\n' "$1" "$2"; }

# 5. Comment stripping: a whole-line comment and a trailing comment go; a `#` inside quotes, a
# `${var#pat}` expansion and a case pattern stay. THE falsification of the shipped defect — the
# needle in a docblock is exactly what greened the presence validator off plan-epic's prose.
mkdir -p "$tmp/strip"
{
	printf '#!/usr/bin/env bash\n'
	printf '# NEEDLE_IN_A_DOCBLOCK\n'
	printf 'keep_me=1   # NEEDLE_IN_A_TRAILING_COMMENT\n'
	printf 'printf "a#b\\n"\n'
	printf 'x="${v#pre}"\n'
	printf 'case "$s" in *#*) : ;; esac\n'
} > "$tmp/strip/f.sh"
out="$(kp_surface_text "$tmp/strip/f.sh")"; rc=$?
if [ "$rc" -ne 0 ]; then
	fail "kp_surface_text: rc=$rc on a readable file"
elif grep -q 'NEEDLE_IN_A_DOCBLOCK' <<<"$out"; then
	fail "comment stripping: a docblock needle survived — the #4541 fail-open is still open"
elif grep -q 'NEEDLE_IN_A_TRAILING_COMMENT' <<<"$out"; then
	fail "comment stripping: a trailing-comment needle survived"
elif ! grep -q 'a#b' <<<"$out"; then
	fail "comment stripping: a # inside a string was eaten"
elif ! grep -q '${v#pre}' <<<"$out"; then
	fail "comment stripping: a \${var#pat} expansion was eaten"
elif ! grep -q 'in \*#\*)' <<<"$out"; then
	fail "comment stripping: a case pattern containing # was eaten"
else
	ok "comment stripping drops comments and keeps every non-comment #"
fi

# 6. A non-`.sh` surface file is passed through verbatim — SKILL.md is markdown, not shell.
printf '# a markdown heading, not a comment\n' > "$tmp/strip/S.md"
out="$(kp_surface_text "$tmp/strip/S.md")"; rc=$?
if [ "$rc" -eq 0 ] && grep -q 'a markdown heading' <<<"$out"; then
	ok "non-.sh surface text passes through verbatim"
else
	fail "non-.sh passthrough: rc=$rc out=[$out]"
fi

# 7. kp_surface_text on an unreadable file: nothing on stdout, non-zero, a diagnostic.
printf 'x\n' > "$tmp/strip/locked.sh"
chmod 000 "$tmp/strip/locked.sh"
if [ -r "$tmp/strip/locked.sh" ]; then
	fail "fixture did not take: locked.sh is still readable (running as root?) — the unreadable-file case was NOT exercised"
else
	err="$tmp/stderr"
	out="$(kp_surface_text "$tmp/strip/locked.sh" 2>"$err")"; rc=$?
	diag="$(cat "$err")"
	if [ "$rc" -eq 0 ]; then
		fail "unreadable surface file returned 0 — 'could not read' is being laundered into 'no match'"
	elif [ -n "$out" ]; then
		fail "unreadable surface file emitted [$out] — it must emit nothing"
	elif [ -z "$diag" ]; then
		fail "unreadable surface file returned $rc with an empty stderr — non-zero with no diagnostic is itself a fail-open"
	else
		ok "unreadable surface file: exit $rc, empty stdout, diagnostic on stderr"
	fi
fi
chmod 644 "$tmp/strip/locked.sh"

# Edge fixtures: a skill that sources a shared script, one that only names the path in a comment,
# one whose edge target is missing, one that sources a SIBLING skill, and one that sources nothing.
mkdir -p "$tmp/e/shared/scripts" "$tmp/e/shared/lib" \
	"$tmp/e/sourcer/scripts" "$tmp/e/commenter/scripts" "$tmp/e/broken/scripts" \
	"$tmp/e/sibling/scripts" "$tmp/e/lonely/scripts" "$tmp/e/owndir/scripts"
printf 'MARKER=shared\n' > "$tmp/e/shared/scripts/probe.sh"
printf 'x\n' > "$tmp/e/shared/lib/common.sh"
for s in sourcer commenter broken sibling lonely owndir; do printf 'x\n' > "$tmp/e/$s/SKILL.md"; done

idiom '../../shared/scripts' 'probe.sh' > "$tmp/e/sourcer/scripts/w.sh"
printf '# ../../shared/scripts/probe.sh — named in a comment only\n' > "$tmp/e/commenter/scripts/w.sh"
idiom '../../shared/scripts' 'gone.sh' > "$tmp/e/broken/scripts/w.sh"
idiom '../../sourcer/scripts' 'w.sh' > "$tmp/e/sibling/scripts/w.sh"
printf 'echo nothing sourced\n' > "$tmp/e/lonely/scripts/w.sh"
printf 'x\n' > "$tmp/e/owndir/scripts/helper.sh"
idiom '.' 'helper.sh' > "$tmp/e/owndir/scripts/w.sh"

edges_of() { kp_skill_source_edges "$tmp/e" "$1"; }

# 8. A real source edge widens the surface to the shared file — demonstrated dependency.
out="$(edges_of sourcer)"; rc=$?
if [ "$rc" -eq 0 ] && [ "$out" = "$tmp/e/shared/scripts/probe.sh" ]; then
	ok "a sourced shared script enters the surface (one hop, widen-never-replace)"
else
	fail "sourcer edge: rc=$rc out=[$out]"
fi

# 9. THE #4541 PIN: a comment naming the shared path resolves NO edge, so a marker that lives only
# in the shared file cannot be claimed by a skill that merely mentions it.
out="$(edges_of commenter)"; rc=$?
if [ "$rc" -ne 0 ]; then
	fail "commenter: rc=$rc — a comment is not an error, it is simply not an edge"
elif [ -n "$out" ]; then
	fail "commenter: a COMMENT naming the shared path resolved an edge [$out] — commentary is being read as wiring (#4541)"
else
	ok "a comment naming the shared path resolves no edge"
fi

# 10. A named edge whose target is missing is UNRESOLVED — red, nothing on stdout (ADR 0230 rule 4).
err="$tmp/stderr"
out="$(edges_of broken 2>"$err")"; rc=$?
diag="$(cat "$err")"
if [ "$rc" -eq 0 ]; then
	fail "broken edge returned 0 — an unresolvable edge is UNKNOWN, never a narrower surface"
elif [ -n "$out" ]; then
	fail "broken edge emitted [$out] — it must emit nothing"
elif [ -z "$diag" ]; then
	fail "broken edge returned $rc with an empty stderr — non-zero with no diagnostic is itself a fail-open"
else
	ok "broken edge: exit $rc, empty stdout, named diagnostic on stderr"
fi

# 11. An edge into a SIBLING skill is outside the allowlist — red. Without this, skill A greens off
# wiring skill B owns and can delete at will (#4505 T4).
out="$(edges_of sibling 2>"$err")"; rc=$?
diag="$(cat "$err")"
if [ "$rc" -eq 0 ]; then
	fail "sibling-skill edge returned 0 — the followed-target allowlist is not enforced (T4)"
elif [ -n "$out" ]; then
	fail "sibling-skill edge emitted [$out] — it must emit nothing"
elif [ -z "$diag" ]; then
	fail "sibling-skill edge returned $rc with an empty stderr"
else
	ok "sibling-skill edge: refused, exit $rc, empty stdout, named diagnostic"
fi

# 12. A skill that sources nothing keeps EXACTLY today's surface — the widening is opt-in by
# evidence, so #4470's property is preserved rather than traded.
out="$(edges_of lonely)"; rc=$?
if [ "$rc" -eq 0 ] && [ -z "$out" ]; then
	ok "a skill that sources nothing gains nothing (exit 0, no output)"
else
	fail "lonely: rc=$rc out=[$out]"
fi

# 13. An edge into the skill's OWN directory is allowlisted, and is not re-emitted: the own surface
# already carries it, and the widening ADDS, it never duplicates.
out="$(edges_of owndir)"; rc=$?
if [ "$rc" -eq 0 ] && [ -z "$out" ]; then
	ok "an own-directory edge is allowed and adds nothing already in the own surface"
else
	fail "owndir: rc=$rc out=[$out]"
fi

# 14. A source line naming a shared/ target in ANY shape but the documented idiom is UNRESOLVED, not
# quietly unfollowed — the variable-interpolated form that defeats a generic resolver (#4505 T1).
mkdir -p "$tmp/e/interp/scripts"
printf 'x\n' > "$tmp/e/interp/SKILL.md"
printf '. "$dir/../../shared/scripts/probe.sh"\n' > "$tmp/e/interp/scripts/w.sh"
out="$(edges_of interp 2>"$err")"; rc=$?
diag="$(cat "$err")"
if [ "$rc" -eq 0 ]; then
	fail "an interpolated shared/ source line returned 0 — a form outside the idiom must be UNRESOLVED (T1)"
elif [ -n "$out" ]; then
	fail "an interpolated shared/ source line emitted [$out] — it must emit nothing"
elif [ -z "$diag" ]; then
	fail "an interpolated shared/ source line returned $rc with an empty stderr"
else
	ok "a shared/ source line outside the idiom: refused, exit $rc, empty stdout, named diagnostic"
fi

# 15. An edge is read from COMMENT-STRIPPED text: commenting the source line out drops the edge.
# The presence validator then reds by needle-not-found, which is the whole point — a commented-out
# edge must not keep following.
mkdir -p "$tmp/e/commentedout/scripts"
printf 'x\n' > "$tmp/e/commentedout/SKILL.md"
{ printf '# '; idiom '../../shared/scripts' 'probe.sh'; } > "$tmp/e/commentedout/scripts/w.sh"
out="$(edges_of commentedout)"; rc=$?
if [ "$rc" -eq 0 ] && [ -z "$out" ]; then
	ok "a commented-out source line follows nothing"
else
	fail "commentedout: rc=$rc out=[$out]"
fi

# 16. The hop cap is the ADR's one-hop rule, mechanised. A literal two hops away is NOT reached, and
# the fix for that is to source it directly rather than to raise the cap.
mkdir -p "$tmp/e/twohop/scripts"
printf 'x\n' > "$tmp/e/twohop/SKILL.md"
idiom '../../shared/scripts' 'first.sh' > "$tmp/e/twohop/scripts/w.sh"
idiom '.' 'second.sh' > "$tmp/e/shared/scripts/first.sh"
printf 'DEEP_MARKER=1\n' > "$tmp/e/shared/scripts/second.sh"
out="$(edges_of twohop)"; rc=$?
if [ "$rc" -eq 0 ] && [ "$out" = "$tmp/e/shared/scripts/first.sh" ] && [ "$KP_EDGE_MAX_HOPS" -eq 1 ]; then
	ok "one hop only: the directly-sourced file enters, the file it sources does not"
else
	fail "twohop: rc=$rc cap=$KP_EDGE_MAX_HOPS out=[$out]"
fi

# 17. THE CREDIT PIN, on the SHIPPED lib rather than a fixture. `shared/lib/common.sh` is
# edge-resolved into the widened surface of ALL FOUR cycle-aware skills (the validators' emitted
# scope line names it `(edge:plan-epic)`, `(edge:write-code)`, `(edge:review-code)`,
# `(edge:ship-it)`), because every one of them sources it — unconditionally, for reasons that have
# nothing to do with the cycle. So a single probe literal in its executable text would green the
# canonical-probe check for four independent skills at once, and "demonstrated dependency" would
# degenerate into "everybody sources it" — directory membership by another name, which is what ADR
# 0230 rule 1 exists to reject. The ADR's blessing of shared credit was written for
# `shared/scripts/cycle-doc-probe.sh`, a file whose only purpose IS the probe; it does not transfer
# here. Keyed on the SAME comment-stripped text the validators grep, so a mention in this file's
# prose is correctly not a violation — only executable text is.
probe_literal="contents/product-development-cycle.md"
if ! out="$(kp_surface_text "$lib")"; then
	fail "credit pin: could not read $lib — UNKNOWN, never 'the literal is absent'"
elif grep -qF "$probe_literal" <<<"$out"; then
	fail "credit pin: $lib carries the cycle-doc probe literal ('$probe_literal') in executable shell — it is edge-resolved into all four cycle-aware skills, so this one file would satisfy every skill's canonical-probe check (ADR 0230 rule 1)"
else
	ok "the shared lib carries no cycle-doc probe literal (no blanket four-skill credit)"
fi

cleanup
if [ "$failures" -ne 0 ]; then
	printf '\ncommon-test: %d failure(s)\n' "$failures"
	exit 1
fi
printf '\ncommon-test: all checks passed\n'
