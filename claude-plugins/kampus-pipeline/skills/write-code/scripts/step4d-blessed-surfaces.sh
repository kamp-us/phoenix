#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2016,SC2034
# Step 4d's reference-anchored sub-loop input: the blessed surface-ids from the committed pointer.
#
# Extracted VERBATIM from write-code/SKILL.md's "Reference-anchored generation" fenced block (epic
# #4435 phase 1, #4449). A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is
# phase 2 (#1929).
#
# The moved `|| true` resolves an unreadable/absent pointer to an EMPTY blessed set, which the step
# reads as "no blessed surface changed ⇒ no-op". That is correct for a genuinely absent pointer (the
# graceful-absence contract) and fail-OPEN for an unreadable one; moved as-is per phase 1 and tracked
# in #4501.
#
# SOURCED, never executed — leaving $POINTER and $BLESSED_SURFACES in the sourcing shell is the whole
# point. Sets NO shell options; no EXIT trap (#4476, class #4479).
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

# blessed surface-ids: the keys of the committed pointer's `surfaces` map (ADR 0183).
# Intersect with the surfaces THIS diff renders (Step 4d capture) — only that ∩ is reference-anchored.
# Empty ∩ ⇒ no blessed surface changed ⇒ this whole sub-loop is a no-op; the plain pillars loop stands.
POINTER=packages/design-capture/golden-pointer.json
BLESSED_SURFACES="$(jq -r '.surfaces | keys[]' "$POINTER" 2>/dev/null || true)"
