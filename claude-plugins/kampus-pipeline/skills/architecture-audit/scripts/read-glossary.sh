#!/usr/bin/env bash
# Print the committed architecture + domain vocabulary the audit speaks in. Both files are required:
# auditing in half the vocabulary is how a finding gets named four ways (#851).
#
# Extracted from architecture-audit/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail

for f in .glossary/LANGUAGE.md .glossary/TERMS.md; do
  [ -r "$f" ] || { echo "architecture-audit: $f is unreadable from $(pwd) — run from the repo root." >&2; exit 1; }
done
cat .glossary/LANGUAGE.md
cat .glossary/TERMS.md
