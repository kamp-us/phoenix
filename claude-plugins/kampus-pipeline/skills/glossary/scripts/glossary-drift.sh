#!/usr/bin/env bash
# Scope the glossary update: print the code surfaces that changed since the commit that last touched
# `.glossary/TERMS.md`.
#
# usage: glossary-drift.sh [<source-dir> …]   (defaults to `apps packages`)
#
# THE BOOTSTRAP CASE IS EXIT 4, NOT AN EMPTY DIFF. An uncommitted TERMS.md has no lower bound, and
# `git diff ""..HEAD` is not "nothing changed" — it is bootstrap mode, a different mode entirely (the
# skill's own prose says so). Distinguishing the two is why the empty lower bound gets its own exit code
# and its own line on stdout (§ZS / ADR 0092).
#
# Extracted from glossary/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "glossary: not inside a git repository — NO drift was scoped."; exit 1; }

# the commit that last touched the glossary — the lower bound of "what changed since"
LAST=$(git -C "$ROOT" log -1 --format=%H -- .glossary/TERMS.md)
[ -n "$LAST" ] || { echo "glossary: .glossary/TERMS.md has never been committed — this is BOOTSTRAP mode, not an empty drift."; exit 4; }

# the code surfaces that changed since then (feature folders, public exports, renames)
if [ "$#" -ge 1 ]; then
	git -C "$ROOT" diff --name-status "$LAST"..HEAD -- "$@"
else
	git -C "$ROOT" diff --name-status "$LAST"..HEAD -- apps packages
fi || { echo "glossary: the drift diff against $LAST failed — UNKNOWN, never 'nothing changed'."; exit 1; }
