#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2016,SC2086
# Step 3's orchestrated path: confirm the threaded delegated token owns #N, then hold §7 layer one.
#
# Extracted VERBATIM from write-code/SKILL.md's "Delegated claim" fenced block (epic #4435 phase 1,
# #4449). A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2
# (#1929) — and these lines ARE the verbs, so ADR 0228 keeps them relays: the script passes each
# verb's answer through, it never re-derives the decision.
#
# SOURCED, never executed. The fenced block it replaces ran inline in the agent's shell, so this
# file deliberately sets NO shell options and leaves $PCLI in the sourcing shell. No EXIT trap:
# under bash 3.2 a cleanup trap's last command becomes the script's status, laundering a `set -u`
# abort into exit 0 (#4476, class #4479) — and these verbs are default-deny, so their EXIT STATUS is
# the whole contract.
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

# The one seam this move needed: the block's `<N>` metavariable was substituted by whoever ran the
# step, so the sourcing site passes it instead. Fail closed on an absent one — `claim is-mine` with
# no issue number cannot resolve an owner, and a run that treats that as confirmation would
# implement on a lane it never proved is its own.
N="${1:-}"
if [ -z "$N" ]; then
  printf 'write-code Step 3 (delegated): no issue number — source this as `. "$WRITECODE_SCRIPTS/step3-delegated-claim.sh" <N>`. The delegation was NOT confirmed; do not implement.\n' >&2
  return 1
fi
# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/bin/pipeline-cli"
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
# delegation confirmed + layer one held — skip the direct-path claim below and go implement
