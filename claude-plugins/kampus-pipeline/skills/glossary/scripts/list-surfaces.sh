#!/usr/bin/env bash
# The product/feature surfaces whose nouns the glossary covers: each app's `src/features` directory
# and each workspace package directory. Listed from the tree, never from memory.
#
# usage: list-surfaces.sh
#
# ZERO SCOPE FAILS (§ZS / ADR 0092): the moved fence swallowed both listings with `2>/dev/null`, so a
# repo with neither `apps/*/src/features` nor `packages/*` printed nothing and the caller had no way to
# tell "this repo has no such surfaces" from "the read failed". Emptiness is now exit 4 with its own
# line. bash here has no `nullglob`, so an unmatched glob survives as a literal path — which is why
# each candidate is existence-tested rather than expanded blind.
#
# Extracted from glossary/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "glossary: not inside a git repository — NO surfaces were listed."; exit 1; }

FOUND=0
for d in "$ROOT"/apps/*/src/features "$ROOT"/packages/*/; do
	[ -d "$d" ] || continue
	printf '%s\n' "$d"
	FOUND=1
done
[ "$FOUND" -eq 1 ] || { echo "glossary: no apps/*/src/features and no packages/* in $ROOT — there are NO surfaces here, which is a fact to confirm rather than an empty listing."; exit 4; }
