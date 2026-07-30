#!/usr/bin/env bash
# shellcheck shell=bash
# Reviewer-runnable proof that `write-code/repair.md` is a BYTE-MOVE of the `## Repair mode` section
# that used to live in `write-code/SKILL.md` (#4404).
#
# It slices the section out of SKILL.md at the BASE commit, applies ONLY the three anchor rewrites
# the move required (an in-file `](#…)` link into a section that stayed behind in SKILL.md must
# become `](SKILL.md#…)`), and diffs that against repair.md from its `## Repair mode` heading to EOF.
# Every other byte must match. A clean run prints MATCH and exits 0; any drift prints the diff and
# exits 1.
#
# Usage:  bash claude-plugins/kampus-pipeline/skills/write-code/scripts/verify-repair-extraction.sh [BASE_SHA]
set -uo pipefail

BASE="${1:-0b108e0645d478729c98a7caa3b98064893bb2dc}"
ROOT="$(git rev-parse --show-toplevel)" || exit 1
SKILL=claude-plugins/kampus-pipeline/skills/write-code/SKILL.md
REPAIR="$ROOT/claude-plugins/kampus-pipeline/skills/write-code/repair.md"
TMP="$(mktemp -d)" || exit 1

git show "$BASE:$SKILL" > "$TMP/base.md" || exit 1

# The section: from its own `## Repair mode …` heading up to (not including) the next column-0 `## `.
awk '/^## Repair mode/ {inb=1} inb && /^## / && !/^## Repair mode/ {exit} inb {print}' "$TMP/base.md" \
  | awk '{ lines[NR]=$0 } END { last=NR; while (last>0 && lines[last] ~ /^(-{3}|[[:space:]]*)$/) last--; for (i=1;i<=last;i++) print lines[i] }' \
  > "$TMP/base.section"

if [ ! -s "$TMP/base.section" ]; then
  echo "NO-BASE-SECTION: '## Repair mode' not found in $SKILL at $BASE" >&2
  rm -rf "$TMP"; exit 1
fi

# The three declared seams — and nothing else. Each is a link whose TARGET stayed in SKILL.md.
sed -e 's|](#mis-attribution-guard)|](SKILL.md#mis-attribution-guard)|g' \
    -e 's|](#a-rebase-invalidates-the-pass--rebase--re-review--ship-is-atomic)|](SKILL.md#a-rebase-invalidates-the-pass--rebase--re-review--ship-is-atomic)|g' \
    "$TMP/base.section" > "$TMP/expected"

# repair.md's moved region: its `## Repair mode` heading through EOF. Everything above that heading
# is the new prerequisites header, which is NEW prose and deliberately outside this proof.
awk 'f{print} /^## Repair mode/ && !f {f=1; print}' "$REPAIR" > "$TMP/moved"

echo "scope: base=$BASE section=$(wc -l < "$TMP/base.section" | tr -d ' ') lines, moved=$(wc -l < "$TMP/moved" | tr -d ' ') lines"

if diff -u "$TMP/expected" "$TMP/moved"; then
  echo "MATCH: repair.md is a byte-move of the base '## Repair mode' section (modulo the 3 declared anchor rewrites)."
  rm -rf "$TMP"; exit 0
fi
echo "DRIFT: repair.md is NOT a byte-move of the base section." >&2
rm -rf "$TMP"
exit 1
