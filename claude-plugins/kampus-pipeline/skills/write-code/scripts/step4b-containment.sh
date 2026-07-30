#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2016,SC2034,SC2086
# Step 4b's containment-marker read — the tolerant read of the child's `**Containment:**` line.
#
# Extracted VERBATIM from write-code/SKILL.md's Step 4b fenced block (epic #4435 phase 1, #4449).
# A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2 (#1929).
#
# The moved line's `|| echo none` resolves an UNREADABLE issue body to the same `none` an issue with
# no marker resolves to — the §ZS shape where a failed read poses as the permissive answer. It is
# moved AS-IS on purpose (phase 1 is a relocation, ADR 0228) and tracked separately in #4501; do not
# repair it here.
#
# SOURCED, never executed — leaving $CONTAINMENT in the sourcing shell is the whole point. Sets NO
# shell options: `pipefail` being OFF is what makes the `|| echo none` fallback reachable at all, so
# turning it on here would silently change the moved behavior. No EXIT trap (under bash 3.2 a
# cleanup trap's last command becomes the script's status, laundering a `set -u` abort into exit 0 —
# #4476, class #4479).
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

# The one seam this move needed: the block's `<N>` metavariable was substituted by whoever ran the
# step, so the sourcing site passes it instead. Fail closed on an absent one — `issues/` with no
# number would fall straight into the `|| echo none` fallback and report "not a dark ship".
N="${1:-}"
if [ -z "$N" ]; then
  printf 'write-code Step 4b: no issue number — source this as `. "$WRITECODE_SCRIPTS/step4b-containment.sh" <N>`. $CONTAINMENT was NOT resolved (UNKNOWN, not `none`).\n' >&2
  return 1
fi
# the child's containment marker; a missing line reads as `none` (formats §2 tolerant-read rule)
CONTAINMENT=$(gh api repos/$REPO/issues/$N --jq '.body' \
  | grep -ioE '\**\s*Containment:\**\s*(flag|exempt|none)' | head -n1 \
  | grep -ioE '(flag|exempt|none)' || echo none)
