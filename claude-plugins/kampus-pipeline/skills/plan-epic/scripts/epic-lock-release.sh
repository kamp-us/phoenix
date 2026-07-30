#!/usr/bin/env bash
# Release the `status:planning` epic-lock on <EPIC>. Run on EVERY exit path after a WON acquire —
# done, park, or a fault mid-mutation. The *why* — why release is an explicit agent step and never a
# shell `trap … EXIT`, and why only a lock YOU won may be released — stays in ../SKILL.md §
# Acquire the epic-lock.
#
# usage: epic-lock-release.sh <EPIC>
#
# Exit status is the verb's own: non-zero means the release did NOT complete, which LEAKS the lock
# and wedges the epic (the ADR-0059 catastrophe) — surface it, never swallow it.
#
# Extracted from plan-epic/SKILL.md (#4452, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: epic-lock-release.sh <EPIC>" >&2; exit 2; }
EPIC="$1"
PCLI="$(kp_pcli)" || exit 127
LOCK="$PCLI epic-lock"

# release: run on EVERY exit path AFTER a WON acquire (done, park, or fault mid-mutation).
# `epic-lock release` does BOTH parts: (a) retract OUR OWN claim comment(s) — re-found by session id,
# since the acquire ran in a PRIOR process and its comment id is gone here; and (b) drop the coarse
# label — a 404 is benign (already released), but ANY other DELETE failure is surfaced LOUDLY (a
# silently-swallowed DELETE LEAKS the lock and wedges the epic, the exact ADR-0059 catastrophe).
$LOCK release "$EPIC"
