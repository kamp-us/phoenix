#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2016,SC2154
# Step R2's additive fold-in: the still-anchored, in-scope inline review comments.
#
# Extracted VERBATIM from write-code/SKILL.md's "Also fold in line-anchored inline review comments"
# fenced block (epic #4435 phase 1, #4449). A byte-move, not a rewrite: replacing this glue with
# `pipeline-cli` verbs is phase 2 (#1929).
#
# SOURCED, never executed: it reads the $authorized set R1 built in this shell and the $PR R1 resolved,
# and leaves $ME and $inlineComments there. Sets NO shell options; no EXIT trap (#4476, class #4479).
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

ME=$(gh api user --jq '.login')   # don't action your own author-side replies
# fetch into a var, then pipe to standalone jq — gh's --jq takes no --argjson, and this reuses
# the same $authorized set R1/R2 already built (same pattern as the marker work-list above)
inlineComments=$(gh api "repos/$REPO/pulls/$PR/comments?per_page=100")
# in-scope, still-anchored inline review comments → your additive fix list (id+path+line+body)
jq --argjson authorized "$authorized" --arg me "$ME" \
  '[ .[]
     | select(.line != null)                                  # non-null line ⇒ still anchored to current head (ADR 0058)
     | select(.user.login != $me)                             # skip self-authored thread replies
     | select((.user.login | IN($authorized[]))               # write+ collaborator (ADR 0055), or…
              or .user.login == "copilot-pull-request-reviewer[bot]")  # …the explicitly-included review bot (#383)
   ] | .[] | {id, path, line, body}' <<<"$inlineComments"
