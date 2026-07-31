#!/usr/bin/env bash
# Step 3b — resolve the product-development-cycle doc and review-code's consumption of it.
# The *why* — graceful absence (ADR 0062): absent ⇒ Step 3b's flag-gating verification no-ops and
# contributes no criterion — stays in ../SKILL.md § Step 3b.
#
# usage: bash ./claude-plugins/kampus-pipeline/skills/review-code/scripts/cycle-doc-probe.sh
#
# STDOUT IS THE ANSWER (ADR 0232, .patterns/skill-script-io-contract.md) — two `KEY=value` lines:
#   CYCLE_DOC=present|absent          the canonical probe's resolution
#   CYCLE_GATING=verify-gating|skip   whether the cycle ADMITS Step 3b's gating verification at all
# `verify-gating` does not mean the check fires: Step 3b still runs it only when the containment
# marker also reads `flag`. `skip` is unconditional — no cycle doc, no gating criterion, no FAIL.
# Any other $CYCLE_DOC is UNKNOWN: no stdout, a named stderr diagnostic, non-zero (§ZS, ADR 0092).
#
# It SOURCES the one shared implementation, ../../shared/scripts/cycle-doc-probe.sh, rather than
# carrying a second copy of the probe (#4549). The copy was required once — the cycle validators
# scanned each skill's OWN directory only — and ADR 0230 removed that forcing constraint by having
# them follow a skill's own source edges one hop (`kp_skill_source_edges` in ../../../lib/common.sh).
# In-script sourcing of a shared target stays sanctioned under ADR 0232; only sourcing at an agent's
# top-level command is banned, which is why ../SKILL.md now EXECUTES this script.
#
# THE SOURCE LINE BELOW IS THE LOAD-BEARING TOKEN — this paragraph is not. The validators follow that
# line to the shared file and grep the probe literal THERE, and every `.sh` grep they run is
# comment-stripped, so deleting the line while keeping this text reds them by name.
#
# Extracted from review-code/SKILL.md (#4451, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

REPO="$(kp_repo)" || exit 1
export REPO
# shellcheck source=../../shared/scripts/cycle-doc-probe.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/scripts" && pwd)/cycle-doc-probe.sh"

# The two states are ENUMERATED, not interpolated: an unset or unexpected $CYCLE_DOC cannot be
# laundered into the permissive `absent` answer by a `%s`.
case "${CYCLE_DOC:-}" in
present) printf 'CYCLE_DOC=present\nCYCLE_GATING=verify-gating\n' ;;
absent) printf 'CYCLE_DOC=absent\nCYCLE_GATING=skip\n' ;;
*)
	echo "cycle-doc-probe.sh: the shared probe left \$CYCLE_DOC as '${CYCLE_DOC:-<unset>}' — UNKNOWN, never 'absent'. No answer produced." >&2
	exit 1
	;;
esac
