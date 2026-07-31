#!/usr/bin/env bash
# §CLASS — the origin/main re-resolution of the four artifact-class probes, extracted from
# `gh-issue-intake-formats.md` (epic #4435 phase 1, #4450). The *why* — why the lines are re-resolved
# from `origin/main` rather than imported (#981), and each probe's fail-closed direction — stays in
# that contract's §CLASS prose; the per-step comments travelled with the shell.
#
# MECHANICAL MOVE. Every moved line is byte-identical to the fence it came from and sits at column 0,
# so a reviewer can diff it against the deleted block directly. Verbification is phase 2 (#1929,
# ADR 0228). Do not "improve" it here.
#
# DUAL-MODE (ADR 0232) — the why is `.patterns/skill-script-shell-shape.md` § The dual-mode shape.
#   EXECUTED:  bash ./claude-plugins/kampus-pipeline/skills/shared/scripts/class-probe-resolve.sh <REPO>
#              stdout ⇒ four lines, `HAS_CODE_RE=…`, `HAS_SKILLS_RE=…`, `HAS_DOCS_EXCLUDE_RE=…`,
#              `HAS_DOCS_RE=…` — the same four values the sourced form left in the caller's shell.
#   SOURCED:   no in-script consumer today; the edge stays open for one.
# No EXIT trap — under bash 3.2 a cleanup trap's last command becomes the script's status,
# laundering a `set -u` abort into exit 0 (#4476, class #4479).
#
# The canonical HAS_*_RE lines it reads are, and stay, column-0 assignments in the contract itself:
# `validate-gate-path-drift.sh` asserts each appears there exactly once at column 0, and every live
# consumer resolves them with `grep '^NAME='` off `origin/main`.

if [ "${BASH_SOURCE[0]}" = "$0" ]; then set -uo pipefail; fi   # executed mode only (ADR 0232)

REPO="${REPO:-${1:?class-probe-resolve.sh: REPO unset and no \$1 — refusing to resolve a boundary from an unnamed repo}}"

# Re-resolve a canonical _RE= line from gh-issue-intake-formats.md@main (#981 ?ref=main idiom).
# Prints the live value, or the fail-closed default $2 when the line is unreadable OR TRIVIAL.
FORMATS_RAW="$(gh api "repos/$REPO/contents/claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md?ref=main" -H 'Accept: application/vnd.github.raw' 2>/dev/null || true)"
# NON-TRIVIALITY ASSERT (#4401) — the guard every resolution site below runs before it gates on a
# freshly-stripped pattern. A strip that silently did NOT strip (a surviving `grep -n` line-number
# prefix broke the `^NAME='` anchor) or that yielded nothing still COMPILES: `grep -E ""` matches
# every path and `grep -Ev ""` matches none, BOTH at exit 0 — so the polarity, not the error, decides
# whether the miss is loud or silent. Absence was already handled; triviality was not.
accept_re() {   # $1=name, $2=resolved value, $3=fail-closed default
  case "$2" in
    *"$1='"*) : ;;   # the assignment prefix survived the strip ⇒ not a pattern, a whole line
    *) if [ "${#2}" -ge 4 ]; then printf '%s' "$2"; return 0; fi ;;
  esac
  printf 'TRIVIAL-GATE-BOUNDARY: %s did not resolve to a usable pattern — failing closed.\n' "$1" >&2
  printf '%s' "$3"
}
reresolve_re() {   # $1=var name, $2=fail-closed default
  live="$(printf '%s\n' "$FORMATS_RAW" | grep "^$1=" | head -n1 || true)"
  if [ -z "$live" ]; then printf '%s' "$2"; return 0; fi
  accept_re "$1" "$(printf '%s' "$live" | sed "s/^$1='//; s/'\$//")" "$2"
}
HAS_CODE_RE="$(reresolve_re HAS_CODE_RE '.')"
HAS_SKILLS_RE="$(reresolve_re HAS_SKILLS_RE '.')"
HAS_DOCS_EXCLUDE_RE="$(reresolve_re HAS_DOCS_EXCLUDE_RE '\$^')"   # fail-closed: exclude NOTHING ⇒ every path reaches the doc test
HAS_DOCS_RE="$(reresolve_re HAS_DOCS_RE '.')"                     # fail-closed: every path is a doc

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  printf 'HAS_CODE_RE=%s\n' "$HAS_CODE_RE"
  printf 'HAS_SKILLS_RE=%s\n' "$HAS_SKILLS_RE"
  printf 'HAS_DOCS_EXCLUDE_RE=%s\n' "$HAS_DOCS_EXCLUDE_RE"
  printf 'HAS_DOCS_RE=%s\n' "$HAS_DOCS_RE"
fi
