#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2016
# Step 4b's graceful-absence probe: resolve whether this install HAS a product-development cycle,
# leaving `$CYCLE_DOC` in the caller's shell. Absent ⇒ no cycle ⇒ ship normally, no flag.
#
# Extracted VERBATIM from write-code/SKILL.md's Step 4b fenced block (epic #4435 phase 1, #4449).
# The probe itself stays the SHARED script — this file relays the seam to it and never copies it.
#
# SOURCED, never executed — see `.patterns/skill-script-shell-shape.md`. Sets NO shell options and
# installs no EXIT trap, for the reasons its siblings state.
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

# the canonical cycle-doc probe (formats §1) — the SHARED script, not a skill-local copy; it leaves
# $CYCLE_DOC in this shell. Absent ⇒ no cycle ⇒ ship normally, no flag.
KP_SHARED="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/skills/shared/scripts"
. "$KP_SHARED/cycle-doc-probe.sh"
# ship dark ONLY when:  [ "$CONTAINMENT" = flag ] && [ "$CYCLE_DOC" = present ]
