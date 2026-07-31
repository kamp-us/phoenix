#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2016
# Step R2: fetch the body of the resolving FAIL marker, by the comment id R1's `verdict read` returned.
#
# Extracted VERBATIM from write-code/SKILL.md's Step R2 fenced block (epic #4435 phase 1, #4449).
# A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2 (#1929).
#
# SOURCED, never executed: it reads the $CODE_FAIL_JSON / $DOC_FAIL_JSON / $SKILL_FAIL_JSON that R1
# left in this shell, and leaves $CID there for R3's thread reply. Sets NO shell options; no EXIT trap
# (#4476, class #4479).
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

# The one seam this move needed: the fenced block hardcoded $CODE_FAIL_JSON and told the reader to
# "swap CODE_FAIL_JSON→DOC_FAIL_JSON/SKILL_FAIL_JSON per namespace"; a script cannot be hand-edited
# per namespace, so the sourcing site names the namespace and this indirects to that variable. The
# default preserves the moved default exactly.
FAIL_JSON_VAR="${1:-CODE_FAIL_JSON}"
FAIL_JSON="${!FAIL_JSON_VAR:-}"   # bash indirect expansion, not `eval` — the value is a network payload
# the full body of the resolving FAIL marker — its comment id came from R1's `verdict read` JSON
# (swap CODE_FAIL_JSON→DOC_FAIL_JSON/SKILL_FAIL_JSON per namespace). `verdict read` already
# author-gated and latest-wins-resolved that exact comment, so this is a plain body fetch of it —
# no re-derivation of the resolver. (When the code namespace was resolved via a native
# CHANGES_REQUESTED review rather than a marker, read the review body from
# `repos/$REPO/pulls/$PR/reviews` instead — a native review carries no issue-comment id.)
CID=$(jq -r '.commentId // empty' <<<"$FAIL_JSON")
[ -n "$CID" ] && gh api "repos/$REPO/issues/comments/$CID" --jq '.body'
