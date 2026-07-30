#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1091,SC2034,SC2154
# Read the PR's unresolved inline review threads and their author class (guard 5).
#
# Extracted VERBATIM from ship-it/SKILL.md's Step 3.6 fenced block (epic #4435 phase 1, #4448).
# A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2 (#1929).
#
# SOURCED, never executed. The fenced block it replaces ran inline in the agent's shell, so this
# file deliberately sets NO shell options — several guards here depend on `pipefail` being OFF —
# and leaves its variables and functions in the sourcing shell, which is how the step's later
# blocks still see them.
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

ORG="${REPO%%/*}"; NAME="${REPO#*/}"
# The ONE GraphQL read in ship-it (ADR 0158): REST exposes no isResolved. Read every thread's
# resolution state, its first author's login AND __typename (the ADR-0224 class), and the text the
# substantive-vs-nit judgment needs. Capture the body UNPIPED — `pipefail` is off on this platform,
# so a piped read reports the last stage's status and a dead query would pose as an empty result.
RAW="$(gh api graphql -f query='
  query($o:String!,$n:String!,$pr:Int!) {
    repository(owner:$o, name:$n) {
      pullRequest(number:$pr) {
        reviewThreads(first:100) {
          nodes {
            id
            isResolved
            isOutdated
            path
            line
            comments(first:1) { nodes { author { login __typename } body } }
          }
        }
      }
    }
  }' -F o="$ORG" -F n="$NAME" -F pr="$PR")" || RAW=""

# Validate the payload SHAPE before interpreting it. An unreadable or non-conforming response — a
# 403/503 body, a missing `data`, a present `errors`, a parse failure, a non-zero exit, an EMPTY
# body — is UNKNOWN, and UNKNOWN is neither "no threads" nor "not a bot" (rule 3). `-s` is what
# makes the empty case fail closed: without it an empty stdin yields no output and jq exits 0, so a
# dead read reads back as a PR with zero threads and the gate silently passes.
THREADS="$(printf '%s' "$RAW" | jq -e -s '
    (.[0] // error("empty")) as $r
    | if ($r | has("errors")) and ($r.errors | length) > 0 then error("errors")
      elif ($r.data.repository.pullRequest.reviewThreads.nodes? | type) != "array" then error("shape")
      else $r.data.repository.pullRequest.reviewThreads.nodes end' 2>/dev/null)"
if [ $? -ne 0 ] || [ -z "$THREADS" ]; then
  disarm_intent refuse || INTENT_UNCLEARED=1
  echo "STOP: review-thread read UNREADABLE or non-conforming — author class is UNKNOWN for every thread, and UNKNOWN is human (ADR 0224 rule 3)."
  echo "unresolved review threads unreadable (author class UNKNOWN ⇒ human) — refusing to enqueue"
  exit 1
fi

# Derive the class per unresolved thread. `Bot` is the ONLY value that unlocks the resolve branch;
# every other outcome — `User`, an unrecognised Actor type, a null author, an absent field — is
# `human`, by construction.
printf '%s' "$THREADS" | jq -c '.[] | select(.isResolved==false)
  | {id, path, line,
     author: (.comments.nodes[0].author.login // "<null>"),
     class: (if (.comments.nodes[0].author.__typename? // "") == "Bot" then "bot" else "human" end),
     body: ((.comments.nodes[0].body // "")[0:200])}'
