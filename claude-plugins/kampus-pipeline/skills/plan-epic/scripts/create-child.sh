#!/usr/bin/env bash
# Compose one child's format-2 body through `intake-compose sub-issue` and file it in ONE atomic
# REST create — body AND its type/priority/status:planned labels together. The *why* — why the
# composer owns the format, why the labels go on AT create, and why the spec lives in the §SP
# namespace rather than a fixed /tmp path (#754) — stays in ../SKILL.md § Emit idempotently.
#
# usage: create-child.sh <EPIC> <title> <type-label> <priority-label> <spec-file> [held-for-login]
#
# The optional 6th argument is the login of the human a child is HELD FOR — a fabrika authoring
# brief being the case that forced it (#4693 / #4637-C). It lands two things in the same atomic
# create: the `assignees[]` entry and the `ready-for:human` label. They go together on purpose.
# The assignee is the barrier `write-code`'s picker honours (`step1-candidate-pool.sh` selects
# `.assignee == null`) and the only child attribute `review-plan`'s flip does not touch; the label
# is what makes that barrier CHECKABLE, and the plan gate reds on a `ready-for:human` child whose
# assignee slot is empty (`HELD_CHILD_UNASSIGNED`). Applying them from one argument in one write
# is what makes the half-applied state unreachable — there is no ordering in which the child is
# briefly labelled-but-unassigned, and no run in which a planner sets one and forgets the other.
#
# The spec arrives as a FILE, not an argument: it is multi-line JSON carrying the child's
# `whatToBuild` prose and acceptance criteria, which an argv string mangles. This script relocates
# it into a per-run `mktemp` inside $RUN_SCRATCH before composing — that relocation IS the #754
# guard: concurrent plan-epic runs on sibling epics share /tmp, so a fixed path lets one run's spec
# clobber another's and file a child with a sibling epic's body.
#
# Extracted from plan-epic/SKILL.md (#4452, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 5 ] || { echo "usage: create-child.sh <EPIC> <title> <type-label> <priority-label> <spec-file> [held-for-login]" >&2; exit 2; }
EPIC="$1"; TITLE="$2"; TYPE_LABEL="$3"; PRIORITY_LABEL="$4"; SPEC_IN="$5"; HELD_FOR="${6:-}"
[ -s "$SPEC_IN" ] || { echo "create-child: spec file '$SPEC_IN' is missing/empty — refusing to file a specless child." >&2; exit 2; }
REPO="$(kp_repo)" || exit 1
PCLI="$(kp_pcli)" || exit 127
RUN_SCRATCH="$(kp_scratch_path "plan-epic-$EPIC")" || exit 1   # §SP re-derive (see scratch-open.sh)

# write this child's spec into a per-run temp file, never a shared fixed path (#754)
CHILD_SPEC_FILE="$(mktemp "$RUN_SCRATCH/child.XXXXXX")" || exit 1
cat "$SPEC_IN" > "$CHILD_SPEC_FILE" || exit 1
# The verb composes the format-2 body per the contract and emits it BY VALUE to stdout — no
# hand-re-derived `### What to build` / `### Acceptance criteria`, no `-f body=@file` leak.
BODY="$("$PCLI" intake-compose sub-issue --spec "$CHILD_SPEC_FILE")" || exit 1
# ATOMIC create — body AND its type/priority/status:planned labels in ONE REST write. `POST /issues`
# accepts `labels` and `assignees` inline, so an interrupted run can never leave a label-less or
# (for a held child) momentarily pool-visible issue: the create either lands the issue WITH every
# birth attribute or creates nothing.
CREATE_ARGS=(api "repos/$REPO/issues"
  -f "title=$TITLE"
  -f "body=$BODY"
  -f "labels[]=$TYPE_LABEL" -f "labels[]=$PRIORITY_LABEL" -f "labels[]=status:planned")
if [ -n "$HELD_FOR" ]; then
  CREATE_ARGS=("${CREATE_ARGS[@]}" -f "assignees[]=$HELD_FOR" -f "labels[]=ready-for:human")
fi
CREATE_ARGS=("${CREATE_ARGS[@]}" --jq '{number,id}')
[ "${#CREATE_ARGS[@]}" -gt 0 ] || { echo "create-child: empty gh argument list — refusing to run gh against nothing." >&2; exit 1; }
gh "${CREATE_ARGS[@]}"
