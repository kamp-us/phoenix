#!/usr/bin/env bash
# Run the homing-guard: with an issue number, over the issue you just triaged; with no argument,
# over the whole open triaged backlog. Relays the verb's output and exit status (ADR 0228).
#
# usage: homing-guard.sh [<N>]
#
# Extracted from triage/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

PCLI="$(kp_pcli)" || exit 127

if [ "$#" -ge 1 ]; then
  "$PCLI" homing-guard check --issue "$1"   # the issue you just triaged
else
  "$PCLI" homing-guard check                # the whole open triaged backlog
fi
