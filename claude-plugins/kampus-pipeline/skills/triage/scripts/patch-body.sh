#!/usr/bin/env bash
# Step 4: PATCH #N's body from `<scratch>/body.md`, the enriched body the caller composed in the
# namespace fetch-original.sh opened. Reading the body from a file is what lets multi-line markdown,
# backticks, and the nested `<details>` fences survive the shell.
#
# usage: patch-body.sh <N>
#
# Re-derives the §SP namespace through `kp_scratch_path` — the NON-resetting read, deliberately not
# `kp_scratch_open`, which would delete the body.md this call came to send (#3718).
#
# Extracted from triage/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: patch-body.sh <N>" >&2; exit 2; }
N="$1"
REPO="$(kp_repo)" || exit 1
RUN_SCRATCH="$(kp_scratch_path "triage-$N")" || exit 1

[ -s "$RUN_SCRATCH/body.md" ] || {
  echo "triage: §SP — $RUN_SCRATCH/body.md is missing/empty; refusing to PATCH the issue with an empty body." >&2; exit 1; }
BODY="$(cat "$RUN_SCRATCH/body.md")"
gh api -X PATCH "repos/$REPO/issues/$N" -f body="$BODY"
