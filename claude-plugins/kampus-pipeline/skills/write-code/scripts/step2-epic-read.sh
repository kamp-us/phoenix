#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2016
# Step 2's three reads of the parent epic: its body (the `## Dependencies` topology), its real child
# set with each child's state, and the handoff-note comment stream siblings left.
#
# Extracted VERBATIM from write-code/SKILL.md's Step 2 fenced block (epic #4435 phase 1, #4449).
# A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2 (#1929).
#
# SOURCED, never executed. The fenced block it replaces ran inline in the agent's shell, so this
# file deliberately sets NO shell options and leaves $EPIC in the sourcing shell. No EXIT trap:
# under bash 3.2 a cleanup trap's last command becomes the script's status, laundering a `set -u`
# abort into exit 0 (#4476, class #4479).
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

# The one seam this move needed: the block opened with the placeholder assignment
# `EPIC=<the parent number Step 1's sub-endpoint read resolved — never a guessed or remembered one>`,
# so the sourcing site passes that number instead. The prose constraint is unchanged and is the
# reason for the fail-closed refusal: pass the number Step 1's sub-endpoint read RESOLVED, never a
# guessed or remembered one. An empty $EPIC addresses `repos/$REPO/issues//sub_issues`, which reads
# as an epic with no children — every dependency vacuously closed, every child "unblocked".
EPIC="${1:-}"
if [ -z "$EPIC" ]; then
  printf 'write-code Step 2: no epic number — source this as `. "$WRITECODE_SCRIPTS/step2-epic-read.sh" <the parent number Step 1 resolved>`. NO topology was read (UNKNOWN, not "no dependencies").\n' >&2
  return 1
fi
# the epic body carries the plan + the ## Dependencies topology
gh api repos/$REPO/issues/$EPIC --jq '.body'
# the real child set + each child's state (the list endpoint is source of truth;
# sub_issues_summary undercounts under mixed closed/open children)
gh api "repos/$REPO/issues/$EPIC/sub_issues?per_page=100" \
  --jq '.[] | "#\(.number) [\(.state)] \(.title)"'
# the cross-task signal siblings left — read before assuming what's done
gh api "repos/$REPO/issues/$EPIC/comments?per_page=100" --jq '.[].body'
