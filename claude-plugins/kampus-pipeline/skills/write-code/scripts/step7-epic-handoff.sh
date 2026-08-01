#!/usr/bin/env bash
# Step 7: post the handoff note on the parent epic, gated on owning the CHILD (never the epic).
#
# usage: step7-epic-handoff.sh <N> <EPIC>
#
# WRITE "$RUN_SCRATCH/handoff.md" BEFORE running this; the script names that path on stderr. Its
# answer is its EXIT STATUS — nothing lands on stdout, so non-zero ⇒ NO handoff was posted.
#
# Executed, never sourced (ADR 0232). `claim_is_mine` used to be a function in the sourcing shell; it
# is now step3_5-claim-is-mine.sh, executed as a child, and its EXIT STATUS still gates the post.
#
# The hand-rolled $RUN_SCRATCH derivation duplicates `kp_scratch_path`; collapsing it onto that helper
# is phase 2's call (#1929).
# shellcheck disable=SC1007,SC1091,SC2016,SC2086
set -uo pipefail
# shellcheck source=../../../lib/common.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

HERE="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
[ -n "$HERE" ] || { echo "write-code Step 7: could not resolve this script's own directory — NO handoff was posted." >&2; exit 1; }

# Fail closed on either being absent — an empty child number cannot be claim-verified, and an empty
# epic number addresses `repos/$REPO/issues//comments`.
N="${1:-}"
EPIC="${2:-}"
if [ -z "$N" ] || [ -z "$EPIC" ]; then
	printf 'write-code Step 7: need both numbers — run this as `bash ./claude-plugins/kampus-pipeline/skills/write-code/scripts/step7-epic-handoff.sh <N> <EPIC>`. NO handoff was posted.\n' >&2
	exit 1
fi
REPO="$(kp_repo)" || { echo "write-code Step 7: target repo unresolved — NO handoff was posted." >&2; exit 1; }
# compose under the per-run scratch namespace (§SP), never a fixed /tmp leaf — a concurrent
# coder lane would clobber it and this posts ITS handoff onto your epic, silently (#3718).
# Deterministic (session-keyed), so writing handoff.md in one Bash call and posting it here in
# the next resolves the SAME directory — re-running `mktemp -d` would yield an empty one.
if [ -z "${CLAUDE_CODE_SESSION_ID:-}" ]; then
	echo "write-code: §SP session id unset — refusing to compose a handoff through a shared path (#3718)." >&2
	exit 1
fi
RUN_SCRATCH="${TMPDIR:-/tmp}/kampus-run/$CLAUDE_CODE_SESSION_ID/write-code-$N"
mkdir -p "$RUN_SCRATCH" || {
	echo "write-code: §SP could not create a per-run scratch dir — refusing to compose a handoff through a shared path (#3718)." >&2; exit 1; }
echo "write-code Step 7: §SP handoff file is $RUN_SCRATCH/handoff.md" >&2
# …the handoff must already be at "$RUN_SCRATCH/handoff.md":
[ -s "$RUN_SCRATCH/handoff.md" ] || { echo "write-code: handoff.md is missing/empty — refusing to post an empty handoff." >&2; exit 1; }
BODY="$(cat "$RUN_SCRATCH/handoff.md")"   # ### Handoff: #N — <title> + the three fields
# the handoff to the parent epic is predicated on OWNING THE CHILD — gate on the child's claim
# (Step 3.5), not the epic (which you never claim): only hand off about work whose claim is mine.
bash "$HERE/step3_5-claim-is-mine.sh" "$N" >&2 && gh api repos/$REPO/issues/$EPIC/comments -f body="$BODY" >&2
