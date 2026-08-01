#!/usr/bin/env bash
# Step R2: resolve the PR's linked issue #N, then read its body and comment stream.
#
# usage: stepR2-linked-issue.sh <PR>
#
# stdout is `N=<issue>` first — the machine value every later repair mutation gates on — then the
# issue body and its comment stream, which are the context of what the PR was supposed to do. An
# unresolvable `Fixes #N` refuses with NOTHING on stdout: a repair whose linked issue is UNKNOWN
# cannot be claim-verified, so it must not proceed.
#
# Executed, never sourced (ADR 0232) — `$N` used to land in the sourcing shell.
# shellcheck disable=SC1007,SC1091,SC2016,SC2086
set -uo pipefail
# shellcheck source=../../../lib/common.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

PR="${1:-}"
if [ -z "$PR" ]; then
	printf 'write-code Step R2: no PR number — run this as `bash ./claude-plugins/kampus-pipeline/skills/write-code/scripts/stepR2-linked-issue.sh <PR>`. NO linked issue was resolved.\n' >&2
	exit 1
fi
REPO="$(kp_repo)" || { echo "write-code Step R2: target repo unresolved — NO linked issue was resolved." >&2; exit 1; }

N=$(gh api repos/$REPO/pulls/$PR \
	--jq '.body | capture("(?i)\\b(fix(es|ed)?|close[sd]?|resolve[sd]?)\\s+#(?<n>[0-9]+)") | .n')
if [ -z "$N" ]; then
	echo "write-code Step R2: PR #$PR's body carries no resolvable closing keyword — the linked issue is UNKNOWN, so the repair cannot be claim-verified. Refusing." >&2
	exit 1
fi
echo "N=$N"
gh api repos/$REPO/issues/$N --jq '.body'
gh api "repos/$REPO/issues/$N/comments?per_page=100" --jq '.[].body'
