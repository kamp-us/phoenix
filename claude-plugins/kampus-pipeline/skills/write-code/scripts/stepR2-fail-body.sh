#!/usr/bin/env bash
# Step R2: fetch the body of the resolving FAIL marker, by the comment id R1's `verdict read` returned.
#
# usage: stepR2-fail-body.sh <PR> [code|doc|skill]
#
# stdout is TWO header lines — `CID=<comment id>` and `FAILBODY_FILE=<path>` — followed by the FAIL
# marker body itself. The body is also written to that file, which stepR-frozen-ac.sh reads; `$CID`
# is what R3's thread reply is addressed at.
#
# Executed, never sourced (ADR 0232). It used to read the `$CODE_FAIL_JSON` / `$DOC_FAIL_JSON` /
# `$SKILL_FAIL_JSON` R1 left in the agent's shell, indirecting through a variable NAME passed as $1;
# it now names the NAMESPACE and reads R1's payload out of the §SP scratch dir R1 wrote. An absent
# payload is UNKNOWN (R1 never ran here) and refuses — never an empty FAIL table.
#
# When the code namespace was resolved via a native CHANGES_REQUESTED review rather than a marker,
# read the review body from `repos/$REPO/pulls/$PR/reviews` instead — a native review carries no
# issue-comment id, so there is no CID to fetch.
# shellcheck disable=SC1007,SC1091,SC2016
set -uo pipefail
# shellcheck source=../../../lib/common.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

PR="${1:-}"
if [ -z "$PR" ]; then
	printf 'write-code Step R2: no PR number — run this as `bash ./claude-plugins/kampus-pipeline/skills/write-code/scripts/stepR2-fail-body.sh <PR> [code|doc|skill]`. NO findings were read.\n' >&2
	exit 1
fi
GATE="${2:-code}"   # the moved block hardcoded the code namespace and told the reader to swap per namespace
case "$GATE" in code|doc|skill) ;; *)
	echo "write-code Step R2: unknown namespace '$GATE' — expected code, doc or skill. NO findings were read." >&2
	exit 1 ;;
esac
REPO="$(kp_repo)" || { echo "write-code Step R2: target repo unresolved — NO findings were read." >&2; exit 1; }
if [ -z "${CLAUDE_CODE_SESSION_ID:-}" ]; then
	echo "write-code Step R2: §SP session id unset — cannot re-derive R1's scratch dir (#3718)." >&2
	exit 1
fi
SCRATCH="${TMPDIR:-/tmp}/kampus-run/$CLAUDE_CODE_SESSION_ID/write-code-repair-$PR"
JSON_FILE="$SCRATCH/$GATE-fail.json"
if [ ! -s "$JSON_FILE" ]; then
	echo "write-code Step R2: no R1 payload at $JSON_FILE — Step R1 never ran in this session. That is UNKNOWN, never an empty FAIL table." >&2
	exit 1
fi
# the full body of the resolving FAIL marker — its comment id came from R1's `verdict read` JSON.
# `verdict read` already author-gated and latest-wins-resolved that exact comment, so this is a plain
# body fetch of it — no re-derivation of the resolver.
CID=$(jq -r '.commentId // empty' < "$JSON_FILE")
if [ -z "$CID" ]; then
	echo "write-code Step R2: R1's $GATE payload carries no commentId — the resolving verdict was a native review (read pulls/$PR/reviews) or none at all. NO marker body was fetched." >&2
	exit 1
fi
mkdir -p "$SCRATCH" || { echo "write-code Step R2: §SP could not create a per-run scratch dir (#3718)." >&2; exit 1; }
gh api "repos/$REPO/issues/comments/$CID" --jq '.body' > "$SCRATCH/fail-body.md" \
	|| { echo "write-code Step R2: could not read comment $CID — NO findings were read (UNKNOWN, never 'no findings')." >&2; exit 1; }
printf 'CID=%s\nFAILBODY_FILE=%s\n' "$CID" "$SCRATCH/fail-body.md"
cat "$SCRATCH/fail-body.md"
