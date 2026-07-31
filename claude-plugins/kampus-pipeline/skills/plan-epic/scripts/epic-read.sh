#!/usr/bin/env bash
# Step 1's reads: the epic's shape + labels + child summary, its body and revision marker snapshotted
# into the §SP namespace (ONE GET, so body and updated_at cannot skew), and its current sub-issue
# list. The *why* — why the two fields come from one GET, and why Step 5 reads this snapshot back —
# stays in ../SKILL.md § Step 1.
#
# usage: epic-read.sh <EPIC>
#
# Writes $RUN_SCRATCH/{snap.json,current.md,updated-at.txt}; prints the reads on stdout. A missing
# namespace exits non-zero (the shared lib's `path` never creates one), so "could not read" can
# never surface as an empty-but-fine snapshot.
#
# Extracted from plan-epic/SKILL.md (#4452, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: epic-read.sh <EPIC>" >&2; exit 2; }
EPIC="$1"
REPO="$(kp_repo)" || exit 1
RUN_SCRATCH="$(kp_scratch_path "plan-epic-$EPIC")" || exit 1   # §SP re-derive (see scratch-open.sh)

# the epic, its current body, its labels, and any children it already has
gh api "repos/$REPO/issues/$EPIC" --jq '{number,title,labels:[.labels[].name],sub_issues_summary}'
# capture the body AND its revision marker from ONE GET — reading them in two calls lets a writer
# land between them, yielding an updated_at newer than the captured body (TOCTOU skew); the Step 5
# recheck would then either spuriously retry or trust a marker that doesn't match the captured body.
gh api "repos/$REPO/issues/$EPIC" --jq '{body,updated_at}' > "$RUN_SCRATCH/snap.json"
jq -r '.body'       "$RUN_SCRATCH/snap.json" > "$RUN_SCRATCH/current.md"
jq -r '.updated_at' "$RUN_SCRATCH/snap.json" > "$RUN_SCRATCH/updated-at.txt"
gh api "repos/$REPO/issues/$EPIC/sub_issues?per_page=100" \
  --jq '.[] | "#\(.number) [\(.state)] \(.title)"'
