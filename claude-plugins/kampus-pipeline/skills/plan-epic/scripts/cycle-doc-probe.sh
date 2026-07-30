#!/usr/bin/env bash
# Print `present` or `absent` for the product-development cycle doc — the containment marker's
# gate. The *why* — graceful absence (ADR 0062): absent ⇒ this whole step no-ops and children carry
# `none (no cycle doc)` — stays in ../SKILL.md § Stamp the containment marker.
#
# usage: cycle-doc-probe.sh
#
# It SOURCES the one shared implementation, `../../shared/scripts/cycle-doc-probe.sh`, rather than
# carrying a second copy of the probe: that helper runs the formats-contract canonical probe — the
# content read of `contents/product-development-cycle.md` — and leaves $CYCLE_DOC in this shell.
#
# THE SOURCE LINE BELOW IS THE LOAD-BEARING TOKEN — this paragraph is not. The cycle validators
# follow that line to the shared file and grep the probe literal THERE (`kp_skill_source_edges` in
# ../../shared/lib/common.sh, ADR 0230), and every `.sh` grep they run is comment-stripped. Delete
# the source line while keeping this text and they go red, by name. An earlier version of this
# docblock claimed the opposite — that naming the path *here* is what kept the validators scanning a
# real reference. It was true, and that was the bug: the guard was passing on this comment alone
# (#4541). The citation stays because it tells a reader what the edge reaches, not because a grep
# needs it.
#
# Extracted from plan-epic/SKILL.md (#4452, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

REPO="$(kp_repo)" || exit 1
export REPO
# shellcheck source=../../shared/scripts/cycle-doc-probe.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/scripts" && pwd)/cycle-doc-probe.sh"

# `present` ⇒ consult the cycle for each child's containment (flag|exempt);
# `absent`  ⇒ no marker stamped (children carry `none`).
printf '%s\n' "${CYCLE_DOC:?cycle-doc-probe: the shared probe left \$CYCLE_DOC unset — UNKNOWN, never 'absent'}"
