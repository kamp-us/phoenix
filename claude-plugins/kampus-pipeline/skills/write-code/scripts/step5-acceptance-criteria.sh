#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2016,SC2086
# Step 5's AC enumeration — the checklist that must be satisfied in FULL before a closing keyword.
#
# Extracted VERBATIM from write-code/SKILL.md's Step 5 fenced block (epic #4435 phase 1, #4449).
# A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2 (#1929).
#
# SOURCED, never executed, for consistency with every other step here — its output is read off
# stdout, not out of a variable. Sets NO shell options: `pipefail` being OFF is what lets the moved
# `|| echo "(no checkbox ACs …)"` fallback fire. No EXIT trap (#4476, class #4479).
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

# The one seam this move needed: the block's `<N>` metavariable was substituted by whoever ran the
# step, so the sourcing site passes it instead. Fail closed on an absent one — with no number the
# fallback line prints and the run would read "no acceptance criteria" for an issue it never read.
N="${1:-}"
if [ -z "$N" ]; then
  printf 'write-code Step 5: no issue number — source this as `. "$WRITECODE_SCRIPTS/step5-acceptance-criteria.sh" <N>`. NO criteria were enumerated (UNKNOWN, not "none").\n' >&2
  return 1
fi
# enumerate #N's acceptance criteria — the checklist you must satisfy in FULL to emit a closing keyword
gh api repos/$REPO/issues/$N --jq '.body' \
  | awk '/^###[[:space:]]*Acceptance criteria/{f=1;next} /^###/{f=0} f' \
  | grep -E '^\s*- \[' || echo "(no checkbox ACs — read the ### Acceptance criteria prose)"
