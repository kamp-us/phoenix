#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2016
# Step 4b's graceful-absence probe: resolve whether this install HAS a product-development cycle.
# EXECUTED, never sourced (ADR 0232): it prints `present` or `absent` on stdout, and the caller
# reads it there. Absent ⇒ no cycle ⇒ ship normally, no flag.
#
# Extracted from write-code/SKILL.md's Step 4b fenced block (epic #4435 phase 1, #4449). The probe
# itself stays the SHARED script — this file relays the seam to it and never copies it.
#
# `set -uo pipefail`, never `-e`, and no EXIT trap (`.patterns/skill-script-shell-shape.md`).
set -uo pipefail
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

# The shared probe reads `$REPO`, which no longer arrives from a sourcing caller — resolve it here
# and fail closed, so an unresolvable repo can never probe `repos//…` and answer `absent`.
if [ -z "${REPO:-}" ]; then
	REPO="$(kp_repo)" || exit 1
fi
# the canonical cycle-doc probe (formats §1) — the SHARED script, not a skill-local copy. Reached by
# the documented BASH_SOURCE-relative idiom, the one form ADR 0230's cycle validators resolve
# statically; the interpolated `${CLAUDE_PLUGIN_ROOT:-…}` shape this replaced could not be.
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/scripts" && pwd)/cycle-doc-probe.sh"
# ship dark ONLY when:  [ "$CONTAINMENT" = flag ] && [ "$CYCLE_DOC" = present ]
printf '%s\n' "$CYCLE_DOC"
