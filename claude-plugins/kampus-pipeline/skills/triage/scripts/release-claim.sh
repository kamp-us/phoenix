#!/usr/bin/env bash
# Step 6: release the sweep-scoped claim on #N. Triage's claim is a mutex, not durable ownership —
# left set, write-code's picker (which skips ANY non-null assignee) would never see the issue again.
# Tolerates an already-released claim: the DELETE is idempotent, so a second release is a no-op.
#
# usage: release-claim.sh <N>
#
# Extracted from triage/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: release-claim.sh <N>" >&2; exit 2; }
REPO="$(kp_repo)" || exit 1

ME=$(gh api user --jq '.login')
gh api -X DELETE "repos/$REPO/issues/$1/assignees" -f "assignees[]=$ME" 2>/dev/null || true
