#!/usr/bin/env bash
# Print the open `status:needs-triage` queue, one `#<n> (<filer>) <title>` line per issue.
# Extracted from triage/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

REPO="$(kp_repo)" || exit 1

gh api "repos/$REPO/issues?state=open&labels=status:needs-triage&per_page=100" \
  --jq '.[] | "#\(.number) (\(.user.login)) \(.title)"'
