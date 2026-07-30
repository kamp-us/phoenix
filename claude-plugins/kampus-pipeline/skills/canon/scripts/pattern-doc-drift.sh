#!/usr/bin/env bash
# Scope the drift for one pattern doc: print the source surfaces that changed since the commit that
# last touched `.patterns/<name>.md`.
#
# usage: pattern-doc-drift.sh <name> <source-dir> [<source-dir> …]
#
# THE BOOTSTRAP CASE IS EXIT 4, NOT AN EMPTY DIFF. An uncommitted doc has no `LAST`, and a
# `git diff ""..HEAD` is not "nothing drifted" — it is a different question entirely (the skill's own
# prose says so). Distinguishing the two is why the empty `LAST` gets its own exit code and its own
# line on stdout (§ZS / ADR 0092).
#
# Extracted from canon/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail

[ "$#" -ge 2 ] || { echo "canon: pattern-doc-drift.sh needs <name> and at least one source dir — NO drift was scoped."; echo "usage: pattern-doc-drift.sh <name> <source-dir> [<source-dir> …]" >&2; exit 2; }
NAME="$1"
shift
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "canon: not inside a git repository — NO drift was scoped."; exit 1; }

# the commit that last touched this pattern doc — the lower bound of "what changed since"
LAST=$(git -C "$ROOT" log -1 --format=%H -- ".patterns/$NAME.md")
[ -n "$LAST" ] || { echo "canon: .patterns/$NAME.md has never been committed — this is the BOOTSTRAP case, not an empty drift."; exit 4; }

# the source surfaces that changed since then (scope to the dirs the doc describes)
git -C "$ROOT" diff --name-status "$LAST"..HEAD -- "$@" ||
	{ echo "canon: the drift diff against $LAST failed — UNKNOWN, never 'nothing drifted'."; exit 1; }
