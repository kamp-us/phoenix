#!/usr/bin/env bash
# Step 2 check 2 — the secret-shaped-added-line scan over the head diff. Extracted from
# review-trivial/SKILL.md (#4453, epic #4435 phase 1). Extraction contract + shell-option rationale:
# ../SKILL.md § The extracted scripts.
#
# The moved line's own `|| echo "no secret-shaped added lines"` is the clean answer, so an EMPTY
# stdout can only mean the scan did not run — which the caller must never read as clean. Hence the
# ref guard below: no readable ref ⇒ a loud line + non-zero, never silence (§ZS / ADR 0092).
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: secret-scan.sh <pr-ref>   # the ref materialize-head.sh printed" >&2; exit 2; }
PR_REF="$1"
git rev-parse --verify --quiet "$PR_REF^{commit}" >/dev/null || {
  echo "secret-scan.sh: '$PR_REF' is not a readable ref — the scan did NOT run; this is UNKNOWN, never 'clean'." >&2; exit 1; }

git show "$PR_REF" | grep -nE '^\+' | grep -niE 'api[_-]?key|secret|token|password|passwd|BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{16}|ghp_[0-9A-Za-z]{30,}|xox[baprs]-|-----BEGIN' || echo "no secret-shaped added lines"
