#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2016
# Step R3: reply on the inline review thread this round addressed.
#
# Extracted VERBATIM from write-code/SKILL.md's Step R3 fenced block (epic #4435 phase 1, #4449).
# A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2 (#1929).
#
# SOURCED, never executed: it reads the $PR and the $CID that stepR2-fail-body.sh left in this shell.
# Sets NO shell options; no EXIT trap (#4476, class #4479).
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

# The one seam this move needed: the block's reply body was a per-run TEMPLATE
# ("Addressed in <short-sha>: <one line on the fix>."), so it stays authored at the sourcing site and
# arrives as $1 — which keeps the template visible in SKILL.md rather than frozen in a script. Fail
# closed on an absent one: an empty body posts a blank reply that claims a fix and says nothing.
REPLY_BODY="${1:-}"
if [ -z "$REPLY_BODY" ]; then
  printf 'write-code Step R3: no reply body — source this as `. "$WRITECODE_SCRIPTS/stepR3-thread-reply.sh" "Addressed in <short-sha>: <one line on the fix>."`. NOTHING was posted.\n' >&2
  return 1
fi
# reply on the inline comment thread you addressed ($CID = the comment id from R2)
gh api -X POST "repos/$REPO/pulls/$PR/comments/$CID/replies" \
  -f body="$REPLY_BODY"
