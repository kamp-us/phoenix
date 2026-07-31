#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2016
# Reviewer-runnable proof that write-code's corpus follows the ADR-0232 executed/stdout convention and
# the .patterns/skill-script-shell-shape.md shape.
#
# It REPLACES `verify-byte-move.sh` and `verify-repair-extraction.sh`, whose shared premise ADR 0232
# retired: both proved the scripts and repair.md were BYTE-IDENTICAL to the fenced blocks they came
# from, and a conversion of those very bytes cannot preserve byte-identity. Keeping a proof whose
# claim the ruling falsified would be worse than no proof — it would go red on the correct diff and
# then be routinely overridden. What is still checkable is the property the conversion has to hold,
# and that is what this asserts.
#
# Usage:  bash claude-plugins/kampus-pipeline/skills/write-code/scripts/verify-executed-contract.sh
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel)" || exit 1
cd "$ROOT" || exit 1
REL=claude-plugins/kampus-pipeline/skills/write-code
fail=0

SCRIPTS=$(git ls-files "$REL/scripts/*.sh" | grep -v "/verify-")
if [ -z "$SCRIPTS" ]; then
  echo "FAIL: zero scope — no script resolved under $REL/scripts (ADR 0092)"
  exit 1
fi
echo "scope: $(printf '%s\n' "$SCRIPTS" | wc -l | tr -d ' ') script(s) under $REL/scripts, plus SKILL.md and repair.md"

echo "=== 1. shell shape: \`set -uo pipefail\`, never \`-e\`, and no cleanup EXIT trap"
while IFS= read -r f; do
  [ -n "$f" ] || continue
  if ! grep -qx 'set -uo pipefail' "$f"; then
    printf 'BAD   %s — no column-0 `set -uo pipefail` line\n' "$f"; fail=1
  fi
  if grep -qE '^set -[a-z]*e[a-z]* ' "$f"; then
    printf 'BAD   %s — enables errexit; `-e` launders a `set -u` abort into exit 0 under a cleanup trap\n' "$f"; fail=1
  fi
  if grep -qE '^[[:space:]]*trap[[:space:]].*EXIT' "$f"; then
    printf 'BAD   %s — installs an EXIT trap; banned outright in this corpus (#4476, class #4479)\n' "$f"; fail=1
  fi
done <<EOF
$SCRIPTS
EOF
[ "$fail" -eq 0 ] && echo "OK    every script opens \`set -uo pipefail\`, none enables -e, none installs an EXIT trap"

echo "=== 2. the retired sourced-class header must be gone"
# shellcheck disable=SC2086
hits=$(grep -nl 'SOURCED, never executed' $SCRIPTS 2>/dev/null || true)
if [ -z "$hits" ]; then
  echo "OK    no script still declares itself SOURCED, never executed"
else
  echo "BAD   still declared sourced:"; printf '%s\n' "$hits"; fail=1
fi

echo "=== 3. no fenced block in SKILL.md / repair.md sources at the TOP LEVEL, and none interpolates CLAUDE_PLUGIN_ROOT into an invocation"
# Column-0 is where the extraction convention puts every runnable line, and a leading `. ` / `source `
# there is exactly the form the harness's isolation verifier refuses (by ANY path shape).
for doc in "$REL/SKILL.md" "$REL/repair.md"; do
  hits=$(grep -nE '^(\.|source)[[:space:]]' "$doc" || true)
  if [ -n "$hits" ]; then
    printf 'BAD   %s carries a top-level sourcing line:\n' "$doc"; printf '%s\n' "$hits"; fail=1
  fi
  hits=$(grep -nE '^[[:space:]]*(\.|source|bash)[[:space:]].*CLAUDE_PLUGIN_ROOT' "$doc" || true)
  if [ -n "$hits" ]; then
    printf 'BAD   %s invokes a script through the interpolated CLAUDE_PLUGIN_ROOT idiom:\n' "$doc"; printf '%s\n' "$hits"; fail=1
  fi
done
[ "$fail" -eq 0 ] && echo "OK    both docs invoke scripts only by literal path"

echo "=== 4. every literal-path invocation in the docs names a script that EXISTS"
# A fence naming a script that isn't there is the silent-no-op this whole corpus exists to avoid: the
# agent runs it, bash reports 127, and a wrapper that reads 127 as an ordinary negative fails open.
INVOKED=$(grep -hoE 'bash \./claude-plugins/kampus-pipeline/skills/[a-z-]+/scripts/[A-Za-z0-9_.-]+\.sh' \
  "$REL/SKILL.md" "$REL/repair.md" | sed 's|^bash \./||' | sort -u)
if [ -z "$INVOKED" ]; then
  echo "FAIL: zero scope — the docs invoke no script by literal path at all (ADR 0092)"
  fail=1
else
  echo "      scope: $(printf '%s\n' "$INVOKED" | wc -l | tr -d ' ') distinct literal-path invocation target(s)"
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    if [ ! -f "$ROOT/$p" ]; then printf 'BAD   %s is invoked but does not exist\n' "$p"; fail=1; fi
  done <<EOF
$INVOKED
EOF
fi

[ "$fail" -eq 0 ] || { echo "FAIL: the executed/stdout convention is not held."; exit 1; }
echo "OK: write-code follows the ADR-0232 executed/stdout convention."
