#!/usr/bin/env bash
# Run the deterministic gate over <EPIC>: `epic-ledger`'s runGate, which validates the ledger and —
# on a clean floor — flips every `status:planned` child to `status:triaged` and posts the PASS
# verdict itself. The *why* — that this is the WHOLE pass/fail decision and must never be
# re-derived in prose — stays in ../SKILL.md § Step 1.
#
# usage: run-gate.sh <EPIC>              # the live gate — flips + comments
#        run-gate.sh <EPIC> --dry-run    # read-only: validate + print, no mutation
#
# Exit status is the gate's own. 127 = the shim never ran, so there is NO verdict — UNKNOWN, never
# a PASS. This script RELAYS the gate's answer; it never derives one (ADR 0228).
#
# Extracted from review-plan/SKILL.md (#4452, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: run-gate.sh <EPIC> [--dry-run]" >&2; exit 2; }
PCLI="$(kp_pcli)" || exit 127
GATE="$PCLI epic-ledger"

# from the repo root:
$GATE "$@"
