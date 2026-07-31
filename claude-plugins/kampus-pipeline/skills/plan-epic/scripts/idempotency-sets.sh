#!/usr/bin/env bash
# Read the two sets a re-dispatch must reconcile against, BEFORE the create loop: this epic's
# already-emitted open children, and the open backlog. The *why* — that emission reconciles rather
# than re-mints, and how to classify a proposed child against each set — stays in ../SKILL.md §
# Emit idempotently.
#
# usage: idempotency-sets.sh <EPIC>
#
# Writes $RUN_SCRATCH/{existing-children.txt,open-backlog.txt}. A missing namespace exits non-zero,
# so an unwritten set can never be read as "nothing already exists".
#
# Extracted from plan-epic/SKILL.md (#4452, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: idempotency-sets.sh <EPIC>" >&2; exit 2; }
EPIC="$1"
REPO="$(kp_repo)" || exit 1
RUN_SCRATCH="$(kp_scratch_path "plan-epic-$EPIC")" || exit 1   # §SP re-derive (see scratch-open.sh)

# 1. Already-emitted OPEN children of THIS epic — the re-dispatch idempotency set. A re-run must
#    SKIP any proposed child that matches one of these (reconcile, don't re-create). The sub-issue
#    list is the source of truth for what the epic already spawned; on a mixed open/closed epic
#    prefer it over sub_issues_summary (which undercounts).
gh api "repos/$REPO/issues/$EPIC/sub_issues?per_page=100" \
  --jq '.[] | select(.state=="open") | .title' > "$RUN_SCRATCH/existing-children.txt"

# 2. The open backlog — the cross-backlog overlap set. A decomposition can re-mint work that
#    already exists as an open standalone issue or another epic's child, so a proposed child that
#    overlaps an open issue is surfaced/skipped, not minted. (REST issue list, not GraphQL.)
gh api "repos/$REPO/issues?state=open&per_page=100" \
  --jq '.[] | select(.pull_request | not) | "#\(.number)\t\(.title)"' > "$RUN_SCRATCH/open-backlog.txt"

echo "idempotency sets written: $RUN_SCRATCH/existing-children.txt, $RUN_SCRATCH/open-backlog.txt"
