#!/usr/bin/env bash
# OPEN the per-run scratch namespace for this plan of <EPIC> and print its absolute path (§SP,
# #3718). Run ONCE, in Step 1 — every later script re-derives the same directory with
# `kp_scratch_path`, which never clears it. The *why* — why the path must be deterministic rather
# than `mktemp -d`, and why an epic number alone is not unique — stays in ../SKILL.md § Step 1.
#
# usage: scratch-open.sh <EPIC>
#
# Fail-closed on a missing session id: the shared lib refuses rather than falling back to a shared
# path, so a non-zero exit is the answer and an empty stdout is never a usable directory.
#
# Extracted from plan-epic/SKILL.md (#4452, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: scratch-open.sh <EPIC>" >&2; exit 2; }
EPIC="$1"

# §SP: the per-run scratch namespace — deterministic + fail-closed, never a shared fallback.
kp_scratch_open "plan-epic-$EPIC" || {
  echo "plan-epic: §SP could not open a per-run scratch dir — refusing to write plan state to a shared path (#3718)." >&2; exit 1; }
