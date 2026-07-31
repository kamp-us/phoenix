#!/usr/bin/env bash
# Step R3: reply on the inline review thread this round addressed.
#
# usage: stepR3-thread-reply.sh <PR> <CID> "Addressed in <short-sha>: <one line on the fix>."
#
# Its answer is its EXIT STATUS — non-zero ⇒ NOTHING was posted.
#
# Executed, never sourced (ADR 0232). It used to read the `$PR` and the `$CID` stepR2-fail-body.sh
# left in the agent's shell; both now arrive as explicit arguments (CID is that script's `CID=` stdout
# line). The reply body stays a per-run TEMPLATE authored at the call site, which is what keeps it
# visible in repair.md rather than frozen in a script.
# shellcheck disable=SC1007,SC1091,SC2016,SC2086
set -uo pipefail
# shellcheck source=../../../lib/common.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

PR="${1:-}"
CID="${2:-}"
REPLY_BODY="${3:-}"
# Fail closed on any absent one: an empty body posts a blank reply that claims a fix and says nothing,
# and an empty PR/CID addresses a thread that is not the one this round answered.
if [ -z "$PR" ] || [ -z "$CID" ] || [ -z "$REPLY_BODY" ]; then
	printf 'write-code Step R3: need the PR, the comment id and a reply body — run this as `bash ./claude-plugins/kampus-pipeline/skills/write-code/scripts/stepR3-thread-reply.sh <PR> <CID> "Addressed in <short-sha>: <one line on the fix>."`. NOTHING was posted.\n' >&2
	exit 1
fi
REPO="$(kp_repo)" || { echo "write-code Step R3: target repo unresolved — NOTHING was posted." >&2; exit 1; }
# reply on the inline comment thread you addressed ($CID = the comment id from R2)
gh api -X POST "repos/$REPO/pulls/$PR/comments/$CID/replies" \
	-f body="$REPLY_BODY" >&2
