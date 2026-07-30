#!/usr/bin/env bash
# Compose one child's format-2 body through `intake-compose sub-issue` and file it in ONE atomic
# REST create — body AND its type/priority/status:planned labels together. The *why* — why the
# composer owns the format, why the labels go on AT create, and why the spec lives in the §SP
# namespace rather than a fixed /tmp path (#754) — stays in ../SKILL.md § Emit idempotently.
#
# usage: create-child.sh <EPIC> <title> <type-label> <priority-label> <spec-file>
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
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

[ "$#" -ge 5 ] || { echo "usage: create-child.sh <EPIC> <title> <type-label> <priority-label> <spec-file>" >&2; exit 2; }
EPIC="$1"; TITLE="$2"; TYPE_LABEL="$3"; PRIORITY_LABEL="$4"; SPEC_IN="$5"
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
# accepts `labels` inline, so an interrupted run can never leave a label-less child: the create
# either lands the issue WITH its labels or creates nothing.
gh api "repos/$REPO/issues" \
  -f title="$TITLE" \
  -f body="$BODY" \
  -f "labels[]=$TYPE_LABEL" -f "labels[]=$PRIORITY_LABEL" -f "labels[]=status:planned" \
  --jq '{number,id}'
