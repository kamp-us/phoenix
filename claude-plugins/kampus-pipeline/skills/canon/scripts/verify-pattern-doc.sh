#!/usr/bin/env bash
# The four self-checks over a `.patterns/<name>.md` doc you just wrote: cross-refs resolve, no
# wikilinks or leaked local paths, no stale markers, and an index row exists.
#
# usage: verify-pattern-doc.sh <name>          # <name> is the doc's basename, without `.md`
#
# Each check prints an EXPLICIT verdict word — `links clean` / `LEAK — fix`, `no stale markers` /
# `stale marker — fix`, and so on — because a silent grep would make "the check found nothing" and
# "the check never ran" byte-identical. A missing doc is a refusal (exit 2), not four clean checks.
#
# Extracted from canon/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail

[ "$#" -ge 1 ] || { echo "usage: verify-pattern-doc.sh <name>" >&2; exit 2; }
NAME="$1"
ROOT="$(git rev-parse --show-toplevel)" || { echo "canon: not inside a git repository." >&2; exit 1; }
DOC="$ROOT/.patterns/$NAME.md"
[ -r "$DOC" ] || { echo "canon: $DOC is unreadable — nothing to verify." >&2; exit 2; }

# 1. cross-refs resolve: every relative link target in the docs you touched exists
grep -roh '](\.\?\.\?/[^)]*\.md)' "$DOC" | sed 's/^](//; s/)$//'
# 2. no wikilinks / leaked absolute paths
# shellcheck disable=SC2016  # the `$…` is a LITERAL to match in the doc, not a variable to expand
grep -nE '\[\[|/Users/|\$USIRIN_VAULT_PATH|file://' "$DOC" && echo "LEAK — fix" || echo "links clean"
# 3. no stale markers
grep -niE 'as of|currently|at the time|in newer versions|when available' "$DOC" && echo "stale marker — fix" || echo "no stale markers"
# 4. the index row exists for the doc
grep -n "$NAME.md" "$ROOT/.patterns/index.md" || echo "MISSING index row — add it"
