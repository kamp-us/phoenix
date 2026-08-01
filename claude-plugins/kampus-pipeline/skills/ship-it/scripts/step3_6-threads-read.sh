#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2016,SC2034,SC2181
# Read the PR's unresolved inline review threads and their author class (guard 5).
#
# Extracted VERBATIM from ship-it/SKILL.md's Step 3.6 fenced block (epic #4435 phase 1, #4448).
# A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2 (#1929).
#
# DUAL-MODE (ADR 0232) — the why is `.patterns/skill-script-shell-shape.md` § The dual-mode shape.
#   EXECUTED:  bash ./claude-plugins/kampus-pipeline/skills/ship-it/scripts/step3_6-threads-read.sh <REPO> <PR>
#              stdout ⇒ one compact JSON object per UNRESOLVED thread (`{id, path, line, author,
#              class, body}`). ZERO objects at exit 0 is the ordinary clean answer — a PR with no
#              unresolved threads — and it is distinguishable from a failed read because THAT prints
#              its two `STOP:` / refusal lines and exits 1. Read the status first (rule 4 / §ZS).
#   SOURCED:   no in-script consumer today; the edge stays open for one.
# No EXIT trap — under bash 3.2 a cleanup trap's last command becomes the script's status,
# laundering a `set -u` abort into exit 0 (#4476, class #4479).

if [ "${BASH_SOURCE[0]}" = "$0" ]; then set -uo pipefail; fi   # executed mode only (ADR 0232)
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"
# `disarm_intent` (guard 6 / ADR 0198), sourced IN-CHAIN — a process inherits no functions (ADR 0232).
# shellcheck source=disarm-intent.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/." && pwd)/disarm-intent.sh"

REPO="${REPO:-${1:?step3_6-threads-read.sh: REPO unset and no \$1 — refusing to read threads in an unnamed repo}}"
PR="${PR:-${2:?step3_6-threads-read.sh: PR unset and no \$2 — refusing to read threads on an unnamed PR}}"
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
  if [ "${BASH_SOURCE[0]}" = "$0" ]; then printf 'INTENT_UNCLEARED=%s\n' "$INTENT_UNCLEARED"; fi
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
