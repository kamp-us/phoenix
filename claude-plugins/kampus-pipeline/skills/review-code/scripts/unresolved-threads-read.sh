#!/usr/bin/env bash
# shellcheck disable=SC2016
# Step 3e — the PR's UNRESOLVED inline review threads (ADR 0158). Extracted from
# review-code/SKILL.md (#4451, epic #4435 phase 1). Extraction contract + shell-option rationale:
# ../SKILL.md § The extracted scripts.
#
# This file carries review-code's ONE sanctioned GraphQL read: `isResolved` has no REST surface, so
# ADR 0158 exempts this single query from the skill's REST-only rule. It is why `gh-phoenix
# lint-skills` names THIS path in its self-exempt array — a per-script entry, never a `scripts/`-wide
# one. Nothing else in this skill may reach for GraphQL.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: unresolved-threads-read.sh <pr>" >&2; exit 2; }
PR="$1"
REPO="$(kp_repo)" || {
	echo "unresolved-threads: UNREADABLE — could not resolve the target repo; thread state is UNKNOWN, which is never 'no unresolved threads' (§ZS)."
	exit 1
}

ORG="${REPO%%/*}"; NAME="${REPO#*/}"
# The ONE GraphQL read in review-code (ADR 0158): REST exposes no isResolved.
gh api graphql -f query='
  query($o:String!,$n:String!,$pr:Int!) {
    repository(owner:$o, name:$n) {
      pullRequest(number:$pr) {
        reviewThreads(first:100) {
          nodes { isResolved path line comments(first:1){ nodes { author { login } body } } }
        }
      }
    }
  }' -F o="$ORG" -F n="$NAME" -F pr="$PR" \
  --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved==false)
        | {path, line, author: .comments.nodes[0].author.login, body: (.comments.nodes[0].body[0:200])}'
RC=$?
# The script boundary invents a channel the inline block never had: a non-zero exit with zero bytes
# of stdout, which the prose downstream would read as "no unresolved threads" — the permissive
# answer. So a failed read speaks its own sentinel and exits non-zero, and the §ZS line below is
# only ever printed on a read that actually ran.
if [ "$RC" -ne 0 ]; then
	echo "unresolved-threads: UNREADABLE — the reviewThreads read exited $RC; thread state is UNKNOWN, which is never 'no unresolved threads' (§ZS)."
	exit 1
fi
echo "unresolved-threads: scanned the PR's review threads (§ZS: this read ran)"
