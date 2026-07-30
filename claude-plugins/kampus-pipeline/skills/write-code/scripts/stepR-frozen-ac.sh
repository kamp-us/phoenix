#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2016
# Freeze-after-round-K: does this round's resolving FAIL table carry a review-appended AC tagged
# at/after the final round (ADR 0079)?
#
# Extracted VERBATIM from write-code/SKILL.md's "Freeze-after-round-K" fenced block (epic #4435 phase
# 1, #4449). A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2
# (#1929).
#
# SOURCED, never executed: it reads the $FAILBODY (the resolving FAIL marker body from R2) the
# sourcing shell carries, and prints its finding on stdout. Sets NO shell options; no EXIT trap
# (#4476, class #4479).
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

# does this round's resolving FAIL table carry a review-appended AC tagged at/after the final round?
# the row is the ordinary checkbox shape; the tag is the only thing read here (no new parser)
# $FAILBODY = the resolving FAIL marker body from R2; grep the provenance tags it carries
echo "$FAILBODY" | grep -oE '<!-- *ac:review-[a-z]+ +pr:#[0-9]+ +round:[0-9]+ *-->' | while read -r tag; do
  K=$(printf '%s' "$tag" | grep -oE 'round:[0-9]+' | cut -d: -f2)
  [ "$K" -ge 3 ] && echo "FROZEN appended AC ($tag) — appended in/after final round; escalate, do not loop"
done
