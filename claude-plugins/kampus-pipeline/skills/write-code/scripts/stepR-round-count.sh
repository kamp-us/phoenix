#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2016,SC2154
# Bounding: how many distinct gate-FAIL ROUNDS this PR has already accrued.
#
# Extracted VERBATIM from write-code/SKILL.md's "Bounding" fenced block (epic #4435 phase 1, #4449).
# A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2 (#1929) — this
# is the one thing `verdict read` deliberately does NOT do (it resolves the latest verdict, it does
# not count rounds), so the counting jq is inherently local until a verb owns it.
#
# SOURCED, never executed: it reads the $authorized set and the $comments_file the pre-pick scan / R1
# left in this shell, and prints the round count on stdout. Sets NO shell options; no EXIT trap
# (#4476, class #4479).
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

# how many distinct gate-FAIL ROUNDS has this PR already accrued (both namespaces)?
# cluster FAIL markers by timestamp gap: a new round starts only when >120s separates two
# FAILs, so a code+doc pass (seconds apart) is one round and two real rounds (fix-push +
# re-review apart) are two — grid-free, so no minute-boundary split or same-minute merge.
jq --argjson authorized "$authorized" \
   '[.[] | select(.user.login | IN($authorized[]))
         | select(.body | test("^\\s*\\**\\s*review-(code|doc|skill):\\s*FAIL"; "i"))
         | .created_at | sub("\\..*Z$";"Z") | fromdateiso8601]
    | sort
    | reduce .[] as $t ({n:0, prev:null};
        if (.prev == null) or ($t - .prev) > 120
        then {n:(.n+1), prev:$t} else {n:.n, prev:$t} end)
    | .n' "$comments_file"
