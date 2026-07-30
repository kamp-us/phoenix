#!/usr/bin/env bash
# Print the resolved `$GATE` command — the `epic-ledger` floor, in-repo first, published fallback
# (ADR 0064; epic #994). The *why* — portability, and why no version is pinned at the call site —
# stays in ../SKILL.md § Step 1.
#
# usage: resolve-gate.sh
#
# This is for your OWN ad-hoc `$GATE …` reads. `run-gate.sh` resolves the shim through the same one
# primitive (the shared lib's `kp_pcli`), so there is still exactly one resolution mechanism.
# Exit 127 = the shim never ran, so there is NO gate command — UNKNOWN, never a degraded run.
#
# Extracted from review-plan/SKILL.md (#4452, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

# resolve the gate command once via the `bin/pipeline-cli` shim — it resolves in-repo bin,
# else the installed bin, else the pinned `pnpm dlx` fallback, reading the ONE pin from
# hooks/pin.sh; no version is pinned here (#3653; ADR 0064; epic #994).
PCLI="$(kp_pcli)" || exit 127
printf '%s epic-ledger\n' "$PCLI"
