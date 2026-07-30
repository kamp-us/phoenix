#!/usr/bin/env bash
# Step 4: remove the release-queue label from the (closed) linked issue — the consume half of #602.
# Idempotent: an issue that no longer carries the label is a harmless no-op.
#
# usage: clear-queue-label.sh <linked-issue>
#
# Extracted from release/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: clear-queue-label.sh <linked-issue>" >&2; exit 2; }
REPO="$(kp_repo)" || exit 1

gh api -X DELETE "repos/$REPO/issues/$1/labels/status:awaiting-release"
