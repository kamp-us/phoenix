#!/usr/bin/env bash
# Step 2 check 3 — the machine-local-path scan over the head diff's added lines, through the SHARED
# matcher. Extracted from review-trivial/SKILL.md (#4453, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
#
# The exit status IS the answer here (0 clean / 2 leak / anything else UNRESOLVED), so this script
# propagates `leak-guard scan-comment`'s status untouched and adds no stdout of its own. Deliberately
# no pattern set lives here: it is single-sourced in
# `packages/pipeline-cli/src/tools/leak-guard/path-matcher.ts`, and a restated token would land in a
# verdict comment that `leak-guard scan-pr` then reads back as a real leak (#4220).
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: leak-scan.sh <pr-ref>   # the ref materialize-head.sh printed" >&2; exit 2; }
PR_REF="$1"
git rev-parse --verify --quiet "$PR_REF^{commit}" >/dev/null || {
  echo "leak-scan.sh: '$PR_REF' is not a readable ref — the scan did NOT run; UNKNOWN, never 'clean'." >&2; exit 1; }
# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="$(kp_pcli)" || exit 127

# added lines only ('+'), scanned by the shared matcher: exit 0 = clean, 2 = leak found
# any OTHER non-zero (4 = the fail-closed stdin read, #4010) is an UNRESOLVED scan, never a pass
git show "$PR_REF" | grep '^+' | "$PCLI" leak-guard scan-comment
