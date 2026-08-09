#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2016
# SC2016 is declared, not suppressed on principle: the fixtures below EMIT shell text, so the single
# quotes are the point — an expanded `${v#pre}` or `$dir` would write a different fixture than the
# one under test.
# Executable pin for kp_skill_shell_surfaces' scan-status contract (#4487), for the source-edge
# surface widening + comment-stripped matching that ADR 0230 adds on top (#4541), and for the
# per-mutation worktree guard the lib hosts so its four SOURCED callers can reach it (#4449). Run it
# directly:
#   bash claude-plugins/kampus-pipeline/lib/common-test.sh
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

# Edge fixtures: a skill that sources a shared script, one that sources the plugin lib a level ABOVE
# the skills dir, one that only names the path in a comment, one whose edge target is missing, one
# that sources a SIBLING skill, and one that sources nothing. The fixture mirrors the shipped layout
# after #4484 — the lib is `$skills_dir/../lib`, NOT inside the skills tree.
mkdir -p "$tmp/e/shared/scripts" "$tmp/lib" \
	"$tmp/e/sourcer/scripts" "$tmp/e/libsourcer/scripts" "$tmp/e/commenter/scripts" \
	"$tmp/e/broken/scripts" "$tmp/e/sibling/scripts" "$tmp/e/lonely/scripts" "$tmp/e/owndir/scripts"
printf 'MARKER=shared\n' > "$tmp/e/shared/scripts/probe.sh"
printf 'MARKER=lib\n' > "$tmp/lib/common.sh"
for s in sourcer libsourcer commenter broken sibling lonely owndir; do printf 'x\n' > "$tmp/e/$s/SKILL.md"; done

idiom '../../shared/scripts' 'probe.sh' > "$tmp/e/sourcer/scripts/w.sh"
idiom '../../../lib' 'common.sh' > "$tmp/e/libsourcer/scripts/w.sh"
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

# 8b. THE #4484 PIN: the shared lib now sits ABOVE the skills dir, so the followed-target allowlist
# has to name `$skills_dir/../lib` too. If it still named only `shared/lib`, every relocated edge
# would land outside the allowlist and refuse — the whole corpus would red at once.
out="$(edges_of libsourcer)"; rc=$?
if [ "$rc" -eq 0 ] && [ "$out" = "$tmp/lib/common.sh" ]; then
	ok "an edge into the plugin lib/ (above the skills dir) is allowed and enters the surface (#4484)"
else
	fail "libsourcer edge: rc=$rc out=[$out] — the allowlist must cover \$skills_dir/../lib (#4484)"
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

# 17. THE CREDIT PIN, on the SHIPPED lib rather than a fixture. `lib/common.sh` is
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

# ---------------------------------------------------------------------------------------------
# #4449 — the per-mutation worktree guard, whose HOME is the seam under test.
# ---------------------------------------------------------------------------------------------

# 18. THE SEAM PIN, and the falsification of the shipped defect. `wt_preflight` / `lane_worktree` are
# called BY NAME from four SOURCED siblings (write-code's `step4-branch.sh`, `step5-push.sh`,
# `stepR2-branch-rebase.sh`, `stepR3-push-and-note.sh`), each of which sources this lib and nothing
# else that could define them. Hosted in the EXECUTED `step4-wt-preflight.sh` instead, they exist
# only in a subprocess and every one of those calls dies 127 — steps 4/5/R2/R3 inoperable, with no
# other check able to see it. `required_fns` above cannot cover this: it derives `kp_`-prefixed names
# only, and these two deliberately keep the unprefixed names their callers use.
for fn in wt_preflight lane_worktree; do
	if type "$fn" >/dev/null 2>&1; then
		ok "$fn is defined by sourcing the lib alone — the four sourced siblings can call it (#4449)"
	else
		fail "$fn is NOT defined by $lib — every sourced caller of it exits 127 (#4449)"
	fi
done

# `lane_worktree` fixture: a repo whose per-worktree git dirs are stamped by hand. It reads only
# `--git-common-dir` plus the `kampus-lane` / `gitdir` files under it, so a real `git worktree add`
# is unnecessary — and a hand-built fixture is what lets case 21 stamp TWO trees with one lane.
mkdir -p "$tmp/lw/main" "$tmp/lw/wtA" "$tmp/lw/wtB"
if ! git -C "$tmp/lw/main" init -q --template='' >/dev/null 2>&1; then
	fail "fixture did not take: could not git-init the lane_worktree fixture — cases 19–21 were NOT exercised"
else
	mkdir -p "$tmp/lw/main/.git/worktrees/A" "$tmp/lw/main/.git/worktrees/B"
	printf '%s/.git\n' "$tmp/lw/wtA" > "$tmp/lw/main/.git/worktrees/A/gitdir"
	printf '%s/.git\n' "$tmp/lw/wtB" > "$tmp/lw/main/.git/worktrees/B/gitdir"
	lane_sid="kp-test-lane-0001"

	# 19. No tree carries this lane's stamp ⇒ REFUSE. Silence is never "use the cwd": the caller's
	# `git -C ""` would fall back to wherever the cwd landed, which is the corruption this guards.
	out="$(cd "$tmp/lw/main" && CLAUDE_CODE_SESSION_ID="$lane_sid" lane_worktree 2>/dev/null)"; rc=$?
	if [ "$rc" -eq 0 ]; then
		fail "lane_worktree returned 0 with no tree stamped for this lane — it must refuse"
	elif [ -n "$out" ]; then
		fail "lane_worktree emitted [$out] with no tree stamped for this lane — it must emit nothing"
	else
		ok "lane_worktree with no stamped tree: non-zero, empty stdout (fail-closed)"
	fi

	# 20. Exactly one stamped tree ⇒ its PHYSICAL root, on stdout, exit 0.
	printf '%s\n' "$lane_sid" > "$tmp/lw/main/.git/worktrees/A/kampus-lane"
	out="$(cd "$tmp/lw/main" && CLAUDE_CODE_SESSION_ID="$lane_sid" lane_worktree)"; rc=$?
	if [ "$rc" -eq 0 ] && [ "$out" = "$tmp/lw/wtA" ]; then
		ok "lane_worktree resolves the single tree stamped with this lane"
	else
		fail "lane_worktree single-stamp: rc=$rc out=[$out] expected [$tmp/lw/wtA]"
	fi

	# 21. Two trees stamped with the same lane is AMBIGUOUS, and ambiguity refuses rather than
	# picking one — the `-eq 1` test, which is also why `set -- $hits` must stay unquoted.
	printf '%s\n' "$lane_sid" > "$tmp/lw/main/.git/worktrees/B/kampus-lane"
	out="$(cd "$tmp/lw/main" && CLAUDE_CODE_SESSION_ID="$lane_sid" lane_worktree 2>/dev/null)"; rc=$?
	if [ "$rc" -eq 0 ] || [ -n "$out" ]; then
		fail "lane_worktree picked a tree from an AMBIGUOUS two-stamp state: rc=$rc out=[$out]"
	else
		ok "lane_worktree with two trees on one lane: non-zero, empty stdout (ambiguity refuses)"
	fi
fi

# The multi-lane fixture (#4500): TWO REAL linked worktrees of ONE session, both stamped with the
# same id — the exact live condition, since sibling subagents share $CLAUDE_CODE_SESSION_ID. Real
# `git worktree add` trees, not hand-built ones, because cases 22–24 resolve from INSIDE a worktree
# and so need `git rev-parse --absolute-git-dir` to answer there.
mkdir -p "$tmp/ml"
if ! git -C "$tmp/ml" init -q --template='' >/dev/null 2>&1 ||
	! git -C "$tmp/ml" -c user.name=kp-test -c user.email=kp-test@invalid commit -q --allow-empty -m init >/dev/null 2>&1 ||
	! git -C "$tmp/ml" worktree add -q -b lane-a "$tmp/ml-a" >/dev/null 2>&1 ||
	! git -C "$tmp/ml" worktree add -q -b lane-b "$tmp/ml-b" >/dev/null 2>&1; then
	fail "fixture did not take: could not build the two-worktree fixture — cases 22–24 were NOT exercised"
else
	ml_sid="kp-test-lane-multi"
	printf '%s\n' "$ml_sid" > "$tmp/ml/.git/worktrees/ml-a/kampus-lane"
	printf '%s\n' "$ml_sid" > "$tmp/ml/.git/worktrees/ml-b/kampus-lane"
	ml_a="$(cd "$tmp/ml-a" && pwd -P)"
	ml_b="$(cd "$tmp/ml-b" && pwd -P)"

	# 22. THE DEFECT (#4500). Two live lanes of one session: each resolves ITS OWN tree. Before the
	# fix both refused, because the session-wide search found two stamps and `-eq 1` cannot hold for
	# a value that is shared by construction — a hard cap of one concurrent lane on the whole factory.
	out="$(cd "$tmp/ml-a" && CLAUDE_CODE_SESSION_ID="$ml_sid" lane_worktree)"; rc=$?
	if [ "$rc" -eq 0 ] && [ "$out" = "$ml_a" ]; then
		ok "lane_worktree in lane A resolves A while a same-session sibling is stamped (#4500)"
	else
		fail "lane_worktree multi-lane A: rc=$rc out=[$out] expected [$ml_a]"
	fi
	out="$(cd "$tmp/ml-b" && CLAUDE_CODE_SESSION_ID="$ml_sid" lane_worktree)"; rc=$?
	if [ "$rc" -eq 0 ] && [ "$out" = "$ml_b" ]; then
		ok "lane_worktree in lane B resolves B while a same-session sibling is stamped (#4500)"
	else
		fail "lane_worktree multi-lane B: rc=$rc out=[$out] expected [$ml_b]"
	fi

	# 23. The two refusals are DISTINGUISHABLE, by exit code and by message. They have opposite
	# remedies, and emitting only the zero-case explanation for both is what kept #4500 misdiagnosed
	# across five reproductions. Read from the fixture's PRIMARY checkout, which is where the
	# session-wide search — and therefore genuine ambiguity — still lives.
	err_many="$(cd "$tmp/ml" && CLAUDE_CODE_SESSION_ID="$ml_sid" wt_preflight 2>&1 >/dev/null)"; rc_many=$?
	rm -f "$tmp/ml/.git/worktrees/ml-a/kampus-lane" "$tmp/ml/.git/worktrees/ml-b/kampus-lane"
	err_none="$(cd "$tmp/ml" && CLAUDE_CODE_SESSION_ID="$ml_sid" wt_preflight 2>&1 >/dev/null)"; rc_none=$?
	if [ "$rc_many" -eq 0 ] || [ "$rc_none" -eq 0 ]; then
		fail "wt_preflight returned 0 from the primary checkout (many=$rc_many none=$rc_none) — both states must refuse"
	elif ! grep -qF 'AMBIGUOUS' <<<"$err_many"; then
		fail "wt_preflight's several-stamps refusal does not name ambiguity: [$err_many]"
	elif grep -qF 'AMBIGUOUS' <<<"$err_none"; then
		fail "wt_preflight's zero-stamp refusal claims ambiguity: [$err_none]"
	elif ! grep -qF 'its tree is gone' <<<"$err_none"; then
		fail "wt_preflight's zero-stamp refusal does not name a missing/torn-down tree: [$err_none]"
	else
		ok "wt_preflight names the actual cause: ambiguity vs missing tree are different messages (#4500)"
	fi

	# 24. A RETIRED stamp is `kampus-lane.retired`, which the `*/kampus-lane` glob does not match and
	# the ambient read does not open — so operator-retired stamps leave a lane unresolvable rather
	# than silently resolving a dead one. Pinned because the retire-by-rename sweep is live on hosts.
	printf '%s\n' "$ml_sid" > "$tmp/ml/.git/worktrees/ml-a/kampus-lane.retired"
	out="$(cd "$tmp/ml-a" && CLAUDE_CODE_SESSION_ID="$ml_sid" lane_worktree 2>/dev/null)"; rc=$?
	if [ "$rc" -eq 0 ] || [ -n "$out" ]; then
		fail "lane_worktree resolved [$out] from a RETIRED stamp (rc=$rc) — a retired lane must not resolve"
	else
		ok "lane_worktree ignores retired stamps (kampus-lane.retired), ambient and search alike"
	fi
fi

# 25. `wt_preflight` with no lane identity at all refuses before it looks at any tree — the
# `${CLAUDE_CODE_SESSION_ID:?}` floor. Run in a subshell because that expansion aborts the shell.
out="$(CLAUDE_CODE_SESSION_ID='' wt_preflight 2>/dev/null)"; rc=$?
if [ "$rc" -eq 0 ]; then
	fail "wt_preflight returned 0 with no session id — it has no lane identity to verify against"
elif [ -n "$out" ]; then
	fail "wt_preflight emitted [$out] with no session id — it must emit nothing"
else
	ok "wt_preflight with no session id: non-zero, empty stdout (fail-closed)"
fi

# ---------------------------------------------------------------------------------------------
# #4826 — the pinned head branch. Real worktrees, because the condition IS a second checkout of one
# branch and no fixture can fake git's own refusal of it.
# ---------------------------------------------------------------------------------------------

mkdir -p "$tmp/pin"
pin_sid="kp-test-lane-pin"
if ! git -C "$tmp/pin" init -q --template='' >/dev/null 2>&1 ||
	! git -C "$tmp/pin" -c user.name=kp-test -c user.email=kp-test@invalid commit -q --allow-empty -m c1 >/dev/null 2>&1 ||
	! git -C "$tmp/pin" worktree add -q -b kp-lane "$tmp/pin-lane" >/dev/null 2>&1 ||
	! git -C "$tmp/pin" worktree add -q -b kp-feat "$tmp/pin-left" >/dev/null 2>&1 ||
	! git -C "$tmp/pin" -c user.name=kp-test -c user.email=kp-test@invalid commit -q --allow-empty -m c2 >/dev/null 2>&1; then
	fail "fixture did not take: could not build the pinned-branch fixture — cases 26–31 were NOT exercised"
else
	pin_base="$(git -C "$tmp/pin" symbolic-ref --short HEAD)"
	pin_lane="$(cd "$tmp/pin-lane" && pwd -P)"
	pin_left="$(cd "$tmp/pin-left" && pwd -P)"
	# Real uncommitted work in the leftover lane's tree. It must still be there at the end: eating a
	# dirty tree is strictly worse than the bug this fix closes.
	printf 'precious uncommitted work\n' > "$pin_left/UNCOMMITTED.txt"

	# 26. The classifier separates the five states. A boolean "is it pinned" cannot, and the states
	# have opposite handling — `other` co-checks-out, `primary` and `live-lane` refuse, `dormant-lane`
	# refuses unless it can PROVE the tree is finished. The two same-session reads below carry the
	# IDENTICAL stamp and differ only in their beat: that is the #4868 fix in one assertion, since a
	# discriminator that reads the id alone cannot tell them apart at all.
	printf '%s\n' "$pin_sid" > "$tmp/pin/.git/worktrees/pin-left/kampus-lane"
	kp_lane_beat "$tmp/pin/.git/worktrees/pin-left"
	out_live="$(CLAUDE_CODE_SESSION_ID="$pin_sid" kp_branch_pin "$pin_lane" kp-feat)"
	printf '%s\n' "$(($(date +%s) - 100000))" > "$tmp/pin/.git/worktrees/pin-left/kampus-lane.beat"
	out_dormant="$(CLAUDE_CODE_SESSION_ID="$pin_sid" kp_branch_pin "$pin_lane" kp-feat)"
	rm -f "$tmp/pin/.git/worktrees/pin-left/kampus-lane" "$tmp/pin/.git/worktrees/pin-left/kampus-lane.beat"
	out_other="$(CLAUDE_CODE_SESSION_ID="$pin_sid" kp_branch_pin "$pin_lane" kp-feat)"
	out_mine="$(CLAUDE_CODE_SESSION_ID="$pin_sid" kp_branch_pin "$pin_lane" kp-lane)"
	out_free="$(CLAUDE_CODE_SESSION_ID="$pin_sid" kp_branch_pin "$pin_lane" kp-no-such-branch)"
	out_primary="$(CLAUDE_CODE_SESSION_ID="$pin_sid" kp_branch_pin "$pin_lane" "$pin_base")"
	if [ "$out_live" != "PIN=live-lane
PINROOT=$pin_left" ]; then
		fail "kp_branch_pin: a pinning tree stamped with MY lane and BEATING must read live-lane: [$out_live]"
	elif [ "$out_dormant" != "PIN=dormant-lane
PINROOT=$pin_left" ]; then
		fail "kp_branch_pin: the SAME stamp with a stale beat must read dormant-lane, not live-lane — a discriminator that cannot fall out of live-lane is stuck, not fail-closed (#4868): [$out_dormant]"
	elif [ "$out_other" != "PIN=other
PINROOT=$pin_left" ]; then
		fail "kp_branch_pin: an unstamped pinning tree must read other: [$out_other]"
	elif [ "$out_mine" != "PIN=mine
PINROOT=$pin_lane" ]; then
		fail "kp_branch_pin: my own branch must read mine: [$out_mine]"
	elif [ "$out_free" != "PIN=free
PINROOT=" ]; then
		fail "kp_branch_pin: an unheld branch must read free: [$out_free]"
	elif [ "$out_primary" != "PIN=primary
PINROOT=$(cd "$tmp/pin" && pwd -P)" ]; then
		fail "kp_branch_pin: a branch held by the primary checkout must read primary: [$out_primary]"
	else
		ok "kp_branch_pin separates free / mine / primary / live-lane / dormant-lane / other"
	fi

	# 27. THE FALSIFICATION. The bare `git switch` the step used to run REFUSES here — that refusal is
	# the whole defect — while the sanctioned path puts this lane on the branch, still attached.
	bare_err="$(git -C "$pin_lane" switch kp-feat 2>&1)"; bare_rc=$?
	if [ "$bare_rc" -eq 0 ]; then
		fail "fixture did not take: a bare \`git switch\` onto a branch another worktree holds SUCCEEDED — the pinned-branch condition was NOT reproduced"
	# Assert on the PINNING TREE'S PATH, not on git's wording: 2.40 says "already checked out at
	# '<path>'" and 2.54 says "already used by worktree at '<path>'", and only the pin refusal names
	# that path at all. Grepping the wording passed locally and red on CI's newer git, leaving the
	# sanctioned co-checkout below — this fix's whole point — unexercised there.
	elif ! grep -qF "$pin_left" <<<"$bare_err"; then
		fail "the bare switch failed for some other reason than the pin (its error does not name the pinning tree $pin_left): [$bare_err]"
	else
		err="$tmp/stderr"
		CLAUDE_CODE_SESSION_ID="$pin_sid" kp_switch_head_branch "$pin_lane" kp-feat 2>"$err"; rc=$?
		diag="$(cat "$err")"
		head_ref="$(git -C "$pin_lane" symbolic-ref -q HEAD)"
		if [ "$rc" -ne 0 ]; then
			fail "the sanctioned path refused the routine leftover-tree case (rc=$rc): [$diag]"
		elif [ "$head_ref" != "refs/heads/kp-feat" ]; then
			fail "the sanctioned path left HEAD at [$head_ref] — a DETACHED head is what makes verified-push resolve UNKNOWN (#4826)"
		elif ! grep -qF 'SANCTIONED' <<<"$diag"; then
			fail "the sanctioned co-checkout narrated nothing naming itself sanctioned: [$diag]"
		else
			ok "pinned head branch: the bare switch refuses, the sanctioned co-checkout attaches this lane to the branch"
		fi
	fi

	# 28. The freshen-the-base guarantee survives the sanctioned switch — the guarantee the detached
	# improvisation dropped. The rebase must land, on a branch ref, not a detached head.
	if ! git -C "$pin_lane" -c user.name=kp-test -c user.email=kp-test@invalid rebase "$pin_base" >/dev/null 2>&1; then
		fail "rebase onto $pin_base failed after the sanctioned switch — the freshen-the-base step is not reachable"
	elif [ "$(git -C "$pin_lane" symbolic-ref -q HEAD)" != "refs/heads/kp-feat" ]; then
		fail "the rebase left HEAD detached — verified-push would resolve UNKNOWN and push nothing"
	elif ! git -C "$pin_lane" merge-base --is-ancestor "$pin_base" HEAD; then
		fail "kp-feat is not on top of $pin_base after the rebase — the base was never freshened"
	else
		ok "the rebase onto the latest base still happens on the sanctioned path, on an attached branch"
	fi

	# 29. THE SAFETY PIN. The leftover tree is still registered and its uncommitted work is still
	# there: the sanctioned path removes no worktree, so there is no `--force` to eat a dirty tree.
	if [ ! -f "$pin_left/UNCOMMITTED.txt" ]; then
		fail "the leftover worktree's uncommitted file is GONE — a removal was introduced (#4826 hard constraint)"
	elif [ "$(cat "$pin_left/UNCOMMITTED.txt")" != "precious uncommitted work" ]; then
		fail "the leftover worktree's uncommitted file was modified"
	elif ! git -C "$tmp/pin" worktree list --porcelain | grep -qF "worktree $pin_left"; then
		fail "the leftover worktree was UNREGISTERED — the sanctioned path must remove nothing"
	else
		ok "the leftover worktree and its dirty, uncommitted work are untouched (nothing removed)"
	fi

	# 30. The primary checkout is never co-checked-out: its branch ref would move under the shared
	# tree. Refusal names the remedy, and this lane's HEAD does not move.
	err="$tmp/stderr"
	CLAUDE_CODE_SESSION_ID="$pin_sid" kp_switch_head_branch "$pin_lane" "$pin_base" 2>"$err"; rc=$?
	diag="$(cat "$err")"
	if [ "$rc" -eq 0 ]; then
		fail "the sanctioned path co-checked-out a branch held by the PRIMARY checkout — the #2270 class"
	elif [ "$(git -C "$pin_lane" symbolic-ref -q HEAD)" != "refs/heads/kp-feat" ]; then
		fail "the primary refusal moved this lane's HEAD — a refusal must change nothing"
	elif ! grep -qF 'REMEDY:' <<<"$diag"; then
		fail "the primary refusal names no remedy: [$diag] — a refusal with no way forward is what gets improvised past"
	else
		ok "a branch held by the primary checkout: refused, HEAD unmoved, remedy named"
	fi

	# 31. A pinning tree stamped with THIS session is a sibling lane that may still be building on the
	# branch; the rebase would move its HEAD mid-flight. Refuse, name the remedy, remove nothing.
	# Deliberately left as it shipped: with no beat this is now the liveness-UNKNOWN read, and it must
	# still refuse — this fixture has no remote, so the tree cannot be proved finished (#4868 AC1).
	if ! git -C "$tmp/pin" worktree add -q -b kp-sib "$tmp/pin-sib" >/dev/null 2>&1; then
		fail "fixture did not take: could not add the sibling-lane worktree — case 31 was NOT exercised"
	else
		printf '%s\n' "$pin_sid" > "$tmp/pin/.git/worktrees/pin-sib/kampus-lane"
		CLAUDE_CODE_SESSION_ID="$pin_sid" kp_switch_head_branch "$pin_lane" kp-sib 2>"$err"; rc=$?
		diag="$(cat "$err")"
		if [ "$rc" -eq 0 ]; then
			fail "the sanctioned path co-checked-out a branch held by a LIVE sibling lane of this session"
		elif ! grep -qF 'REMEDY:' <<<"$diag"; then
			fail "the live-lane refusal names no remedy: [$diag]"
		elif ! git -C "$tmp/pin" worktree list --porcelain | grep -qF "worktree $(cd "$tmp/pin-sib" && pwd -P)"; then
			fail "the live-lane refusal removed the sibling worktree"
		else
			ok "a branch held by a same-session sibling lane: refused, remedy named, nothing removed"
		fi
	fi
fi

# ---------------------------------------------------------------------------------------------
# #4868 — the lane stamp's LIFECYCLE. A real remote, because "is this work anywhere but that tree?"
# is the fact that separates a leftover tree it is safe to release from one holding the only copy.
#
# The bare repo is populated by FETCHING INTO IT from the working repo, never by pushing out of it:
# the corpus lint reds on a bare push anywhere in a runnable block — and a `.sh` is runnable in
# whole, comments included — with deliberately no pragma and no exempt list (#4213, ADR 0202). The
# fixture only needs the objects and refs to exist over there, and a fetch puts them there.
# ---------------------------------------------------------------------------------------------

mkdir -p "$tmp/rel" "$tmp/rel-bare"
rel_sid="kp-test-lane-rel"
if ! git -C "$tmp/rel-bare" init -q --bare >/dev/null 2>&1 ||
	! git -C "$tmp/rel" init -q --template='' >/dev/null 2>&1 ||
	! git -C "$tmp/rel" -c user.name=kp-test -c user.email=kp-test@invalid commit -q --allow-empty -m r1 >/dev/null 2>&1 ||
	! git -C "$tmp/rel" remote add origin "$tmp/rel-bare" >/dev/null 2>&1 ||
	! git -C "$tmp/rel" worktree add -q -b rel-lane "$tmp/rel-lane" >/dev/null 2>&1 ||
	! git -C "$tmp/rel" worktree add -q -b rel-feat "$tmp/rel-feat" >/dev/null 2>&1 ||
	! git -C "$tmp/rel" worktree add -q -b rel-done "$tmp/rel-done" >/dev/null 2>&1 ||
	! git -C "$tmp/rel-bare" fetch -q "$tmp/rel" rel-feat:refs/heads/rel-feat rel-done:refs/heads/rel-done >/dev/null 2>&1 ||
	! git -C "$tmp/rel" fetch -q origin >/dev/null 2>&1; then
	fail "fixture did not take: could not build the lane-lifecycle fixture — cases 32–36 were NOT exercised"
else
	rel_lane="$(cd "$tmp/rel-lane" && pwd -P)"
	rel_feat="$(cd "$tmp/rel-feat" && pwd -P)"
	rel_feat_admin="$tmp/rel/.git/worktrees/rel-feat"
	rel_done_admin="$tmp/rel/.git/worktrees/rel-done"
	err="$tmp/stderr"

	# 32. A sibling lane that is genuinely LIVE — same session, and beating right now — is still
	# refused, HEAD unmoved, nothing removed, stamp NOT retired. This is the property the fix must not
	# trade away: the refusal is correct here (#4868 AC1).
	printf '%s\n' "$rel_sid" > "$rel_feat_admin/kampus-lane"
	kp_lane_beat "$rel_feat_admin"
	CLAUDE_CODE_SESSION_ID="$rel_sid" kp_switch_head_branch "$rel_lane" rel-feat 2>"$err"; rc=$?
	diag="$(cat "$err")"
	if [ "$rc" -eq 0 ]; then
		fail "a BEATING same-session sibling lane was co-checked-out — the guard was weakened into fail-open (#4868 AC1)"
	elif [ "$(git -C "$rel_lane" symbolic-ref -q HEAD)" != "refs/heads/rel-lane" ]; then
		fail "the live-lane refusal moved this lane's HEAD — a refusal must change nothing"
	elif [ ! -f "$rel_feat_admin/kampus-lane" ]; then
		fail "the live-lane refusal RETIRED a live lane's stamp — only a proven-finished tree may be released"
	else
		ok "a beating same-session sibling lane: still refused, HEAD unmoved, its stamp left alone"
	fi

	# 33. The refusal names a remedy THE REFUSING AGENT CAN RUN. The two it used to name could not be
	# executed by anyone who could read it: `wt_preflight` refuses a sibling tree, and "wait for it to
	# finish" never cleared while the stamp was written once and never moved (#4868 AC4).
	if ! grep -qF 'REMEDY' <<< "$diag"; then
		fail "the live-lane refusal names no remedy at all: [$diag]"
	elif grep -qF "run this repair from that lane's worktree" <<< "$diag"; then
		fail "the live-lane refusal still names the sibling-worktree remedy, which wt_preflight refuses: [$diag]"
	elif ! grep -qF 're-run this same step' <<< "$diag"; then
		fail "the live-lane refusal names no step the refusing agent can perform itself: [$diag]"
	else
		ok "the live-lane refusal names a remedy the refusing agent can execute (#4868 AC4)"
	fi

	# 34. Liveness unknown is NOT a licence. A stale beat over a tree holding uncommitted work is
	# refused, the reason names the work, and nothing is retired — the beat is one of two signals and
	# releasing takes both.
	printf '%s\n' "$(($(date +%s) - 100000))" > "$rel_feat_admin/kampus-lane.beat"
	printf 'precious uncommitted work\n' > "$rel_feat/UNCOMMITTED.txt"
	CLAUDE_CODE_SESSION_ID="$rel_sid" kp_switch_head_branch "$rel_lane" rel-feat 2>"$err"; rc=$?
	diag="$(cat "$err")"
	if [ "$rc" -eq 0 ]; then
		fail "a dormant lane's DIRTY tree was released — uncommitted work would have moved under it"
	elif [ ! -f "$rel_feat_admin/kampus-lane" ]; then
		fail "an unproven dormant lane's stamp was retired anyway"
	elif ! grep -qF 'UNCOMMITTED' <<< "$diag"; then
		fail "the dormant refusal does not name WHICH fact failed: [$diag]"
	elif ! grep -qF 're-run this same step' <<< "$diag"; then
		fail "the dormant refusal names no step the refusing agent can perform itself: [$diag]"
	else
		ok "a dormant lane holding uncommitted work: refused, reason named, stamp left alone"
	fi

	# 35. THE STATE THAT COULD NOT EXIST BEFORE (#4868 AC2). The tree is clean, on the branch tip, and
	# that commit is on a remote — so a stale-beat same-session lane is provably finished with it and
	# the pin resolves to the sanctioned co-checkout. The stamp is retired by RENAME, and the worktree
	# and every file in it survive.
	rm -f "$rel_feat/UNCOMMITTED.txt"
	printf 'a file this tree keeps\n' > "$rel_feat/KEEP.txt"
	git -C "$rel_feat" add KEEP.txt >/dev/null 2>&1
	git -C "$rel_feat" -c user.name=kp-test -c user.email=kp-test@invalid commit -q -m keep >/dev/null 2>&1
	git -C "$tmp/rel-bare" fetch -q "$tmp/rel" rel-feat:refs/heads/rel-feat >/dev/null 2>&1
	git -C "$rel_feat" fetch -q origin >/dev/null 2>&1
	CLAUDE_CODE_SESSION_ID="$rel_sid" kp_switch_head_branch "$rel_lane" rel-feat 2>"$err"; rc=$?
	diag="$(cat "$err")"
	if [ "$rc" -ne 0 ]; then
		fail "a PROVABLY finished same-session lane still blocked the repair (rc=$rc): [$diag] — the positive branch is still unfalsifiable (#4868 AC2)"
	elif [ "$(git -C "$rel_lane" symbolic-ref -q HEAD)" != "refs/heads/rel-feat" ]; then
		fail "the release did not attach this lane to rel-feat — a DETACHED head makes verified-push resolve UNKNOWN"
	elif [ -f "$rel_feat_admin/kampus-lane" ] || [ ! -f "$rel_feat_admin/kampus-lane.retired" ]; then
		fail "the stamp was not retired by rename — the next repair reads the same stuck state again"
	elif [ ! -f "$rel_feat/KEEP.txt" ]; then
		fail "the released worktree's files are GONE — the release must remove nothing"
	elif ! git -C "$tmp/rel" worktree list --porcelain | grep -qF "worktree $rel_feat"; then
		fail "the released worktree was UNREGISTERED — the release must remove no worktree (#4868 AC5)"
	else
		ok "a finished same-session lane's leftover tree: pin released, stamp retired, worktree and files untouched (#4868 AC2/AC5)"
	fi

	# 36. The lane-finish seam, read from the other end: a retired stamp reads `other`, the ordinary
	# leftover-tree state, so nothing has to be proved at all. This is what step8-claim-release.sh
	# produces at the end of every run that stamped a tree.
	printf '%s\n' "$rel_sid" > "$rel_done_admin/kampus-lane"
	kp_lane_beat "$rel_done_admin"
	out_before="$(CLAUDE_CODE_SESSION_ID="$rel_sid" kp_branch_pin "$rel_lane" rel-done)"
	kp_lane_retire "$rel_done_admin"; rc=$?
	out_after="$(CLAUDE_CODE_SESSION_ID="$rel_sid" kp_branch_pin "$rel_lane" rel-done)"
	if [ "$rc" -ne 0 ]; then
		fail "kp_lane_retire failed on a stamped worktree (rc=$rc)"
	elif [ "$out_before" != "PIN=live-lane
PINROOT=$(cd "$tmp/rel-done" && pwd -P)" ]; then
		fail "kp_branch_pin: a beating same-session tree must read live-lane before it retires: [$out_before]"
	elif [ "$out_after" != "PIN=other
PINROOT=$(cd "$tmp/rel-done" && pwd -P)" ]; then
		fail "kp_branch_pin: a RETIRED lane's tree must read other — retiring is what a finished lane does: [$out_after]"
	elif [ -f "$rel_done_admin/kampus-lane.beat" ]; then
		fail "kp_lane_retire left the beat file behind — a retired lane must leave no liveness residue"
	else
		ok "the lane-finish seam: retiring the stamp flips a same-session tree from live-lane to other"
	fi
fi

cleanup
if [ "$failures" -ne 0 ]; then
	printf '\ncommon-test: %d failure(s)\n' "$failures"
	exit 1
fi
printf '\ncommon-test: all checks passed\n'
