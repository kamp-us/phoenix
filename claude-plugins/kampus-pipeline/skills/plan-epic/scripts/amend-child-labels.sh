#!/usr/bin/env bash
# AMEND-ONLY: append/adjust labels on an EXISTING child. Fresh children are labeled AT CREATE
# (create-child.sh), so this never runs on the create path; using it there would reopen the
# label-less-orphan window. The *why* stays in ../SKILL.md § Emit idempotently.
#
# usage: amend-child-labels.sh <CHILD> <type-label> <priority-label>
#
# Extracted from plan-epic/SKILL.md (#4452, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

[ "$#" -ge 3 ] || { echo "usage: amend-child-labels.sh <CHILD> <type-label> <priority-label>" >&2; exit 2; }
CHILD="$1"; TYPE_LABEL="$2"; PRIORITY_LABEL="$3"
REPO="$(kp_repo)" || exit 1

gh api "repos/$REPO/issues/$CHILD/labels" \
  -f "labels[]=$TYPE_LABEL" -f "labels[]=$PRIORITY_LABEL" -f "labels[]=status:planned"
