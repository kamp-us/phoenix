#!/usr/bin/env bash
# The maintainer's kill audit: every issue closed by triage, so over-closing is caught and reopened
# cheaply.
# Extracted from triage/close-not-planned.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

REPO="$(kp_repo)" || exit 1

gh api "repos/$REPO/issues?state=closed&labels=closed-by-triage" \
  --jq '.[] | "#\(.number) \(.title)"'
