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
# Naming that path here is load-bearing, not decoration: `validate-cycle-presence.sh` /
# `validate-cycle-absence.sh` grep for the canonical probe across plan-epic's OWN shell surface
# only (shared/lib is deliberately excluded — see `kp_skill_shell_surfaces` in
# ../../shared/lib/common.sh), so this citation is what keeps the cycle validators scanning a real
# reference instead of nothing.
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
