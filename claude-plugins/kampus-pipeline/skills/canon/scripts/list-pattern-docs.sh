#!/usr/bin/env bash
# List the existing `.patterns/*.md` docs, so a new doc slots into the right layer/prefix and does not
# duplicate one.
#
# usage: list-pattern-docs.sh
#
# ZERO SCOPE FAILS (§ZS / ADR 0092): a repo with no pattern docs at all is exit 4, not silence — an
# empty listing would otherwise read as "nothing to duplicate, write freely", which is the wrong
# conclusion when the real cause is an unresolvable repo root or an unmatched glob (bash has no
# `nullglob` here, so an unmatched pattern survives as a literal path).
#
# Extracted from canon/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "canon: not inside a git repository — .patterns/ was NOT listed."; exit 1; }
[ -d "$ROOT/.patterns" ] || { echo "canon: $ROOT/.patterns does not exist — there is no pattern-doc library in this checkout."; exit 4; }

DOCS="$(find "$ROOT/.patterns" -maxdepth 1 -type f -name '*.md' | LC_ALL=C sort)"
[ -n "$DOCS" ] || { echo "canon: .patterns/ holds no *.md docs — an EMPTY library, which is a fact to confirm, not a listing."; exit 4; }

printf '%s\n' "$DOCS"
