#!/usr/bin/env bash
# Step 3's orchestrated path: confirm the threaded delegated token owns #N, then hold §7 layer one.
#
# usage: step3-delegated-claim.sh <N> [<delegated-token>]
#
# The EXIT STATUS is the whole contract: 0 = the delegation is confirmed and layer one is held;
# non-zero = it is NOT confirmed, so do not implement. Both verbs are default-deny, so nothing here
# re-derives the ownership decision — it relays theirs (ADR 0228).
#
# Executed, never sourced (ADR 0232). The token used to be read from the sourcing shell's
# `$DELEGATED_TOKEN`; it now arrives as an explicit argument, falling back to `$THREADED_CLAIM_TOKEN`
# / `$DELEGATED_TOKEN` in the process env for a caller that exported it.
# shellcheck disable=SC1007,SC1091,SC2016,SC2086
set -uo pipefail
# shellcheck source=../../../lib/common.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

# Fail closed on an absent number — `claim is-mine` with no issue number cannot resolve an owner, and
# a run that treats that as confirmation would implement on a lane it never proved is its own.
N="${1:-}"
if [ -z "$N" ]; then
	printf 'write-code Step 3 (delegated): no issue number — run this as `bash ./claude-plugins/kampus-pipeline/skills/write-code/scripts/step3-delegated-claim.sh <N> <token>`. The delegation was NOT confirmed; do not implement.\n' >&2
	exit 1
fi
DELEGATED_TOKEN="${2:-${THREADED_CLAIM_TOKEN:-${DELEGATED_TOKEN:-}}}"
if [ -z "$DELEGATED_TOKEN" ]; then
	echo "write-code Step 3 (delegated): no delegated token — the delegation was NOT confirmed; do not implement." >&2
	exit 1
fi
# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314). A 127 here means
# the CLI never ran, which is UNKNOWN and never a confirmed delegation.
PCLI="$(kp_pcli)" || exit 127
# Orchestrated path: confirm the delegated claim is the earliest authorized claim, then proceed.
# The §7 CLAIM_RE + write+ ACL + min(created_at, comment id) resolution is owned by the shared verb
# — run it, never re-derive the grammar. Exit 0 = the threaded token owns #N; non-zero = it does
# not (absent, foreign, or superseded) ⇒ abort, do not implement.
"$PCLI" claim is-mine --issue $N --session "$DELEGATED_TOKEN" \
	|| { echo "delegated token is not the earliest authorized claim — abort, do not implement." >&2; exit 1; }
# Ensure §7 LAYER ONE for the whole build (#4298). The dispatcher owes this pre-spawn, but the
# obligation lived in ONE orchestrator's prompt, so a lane dispatched by anything else reached here
# with no assignee — and Step 8's release then freed the resolver on top of a gate that was never
# written, leaving the issue `status:triaged` + unassigned with its PR in review. Idempotent and
# additive: a gate already carrying us is a no-op, and the verb REFUSES on any lane whose claim is
# not ours, so this asserts nothing about the dispatcher and evicts nothing (ADR 0215 §5).
"$PCLI" claim assign --issue $N --session "$DELEGATED_TOKEN" \
	|| { echo "could not set the availability gate on #$N — routed blocker, do not implement." >&2; exit 1; }
# delegation confirmed + layer one held — skip the direct-path claim and go implement
