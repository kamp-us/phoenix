#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2034
# Assert the run-evidence bundle, failing closed on each check with a distinct reason (guard 2).
#
# Extracted VERBATIM from ship-it/SKILL.md's Step 3.5 fenced block (epic #4435 phase 1, #4448).
# A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2 (#1929).
#
# SOURCED, never executed. The fenced block it replaces ran inline in the agent's shell, so this
# file deliberately sets NO shell options — several guards here depend on `pipefail` being OFF —
# and leaves its variables and functions in the sourcing shell, which is how the step's later
# blocks still see them.
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

# Each refusal below (transient, absent, schema, stale, checks-failed) is a stop path, so each
# clears the merge intent before it reports (guard 6 / ADR 0198) — one wrapper, not N hand-copied disarms.
refuse_ship() { disarm_intent refuse || INTENT_UNCLEARED=1; echo "$1"; exit 0; }

# 1a. TRANSIENT / upstream-unavailable (the #3716 fix — this MUST precede 1b). A read 5xx'd, or the
#     listed artifact would not download as a valid zip after retry+backoff — a TRANSPORT failure,
#     UNKNOWN, NOT an absent bundle. Report unverified-transient with the captured cause (probe
#     convention: an unrunnable probe is "unknown", never "down"), so a re-dispatch after the outage
#     clears it. Fail-closed: still declines to merge. Ordered first because on a transient failure
#     RUN_ID/ART_ID/MANIFEST may be empty and would otherwise mis-trip 1b's "no bundle".
if [ "$ART_FETCH_STATUS" = transient ]; then
  refuse_ship "unverified (run-evidence artifact unreachable — transient upstream error, retried: ${ART_FETCH_ERR:-cause unavailable})"
fi

# 1b. GENUINE absence. Reads succeeded but there is no head-SHA run, no run-evidence artifact, or no
#     manifest in it → the PRODUCER yielded nothing, so there is no proof this commit was run →
#     refuse (ADR 0056: the artifact is the storage).
if [ -z "$RUN_ID" ] || [ -z "$ART_ID" ] || [ ! -s "$MANIFEST" ]; then
  refuse_ship "unverified (no run-evidence bundle)"   # refuse — see Running it
fi

# 2. schemaVersion the gate understands. Fail closed on an unrecognized MAJOR rather than
#    misreading a newer shape (ADR 0056 §3 — schema skew is a visible refusal, not a trust hole).
#    schemaVersion is a JSON NUMBER (Manifest.ts: Schema.Number, SCHEMA_VERSION = 1); compare it
#    numerically inside jq (== 1) so a number/string skew can't fail-close a valid bundle. `SCHEMA`
#    is only the human-readable echo for the refusal message.
SCHEMA=$(jq -r '.schemaVersion // empty' "$MANIFEST")
jq -e '.schemaVersion == 1' "$MANIFEST" >/dev/null \
  || refuse_ship "unverified (unsupported bundle schemaVersion: ${SCHEMA:-none})"

# 3. bundle.commit MUST equal the PR head SHA — evidence not for THIS commit is no evidence
#    (ADR 0054 §1). A green run from an earlier push is stale → refuse.
BUNDLE_COMMIT=$(jq -r '.commit // empty' "$MANIFEST")
[ "$BUNDLE_COMMIT" = "$HEAD_SHA" ] || refuse_ship "unverified (stale run-evidence bundle: commit $BUNDLE_COMMIT != head $HEAD_SHA)"

# 4. EVERY checks[] entry must be `pass`. Any `fail` (or an empty checks[]) → refuse.
FAILED=$(jq -r '[.checks[]? | select(.status != "pass") | .name] | join(", ")' "$MANIFEST")
NCHECKS=$(jq -r '.checks | length' "$MANIFEST")
if [ "$NCHECKS" -eq 0 ] || [ -n "$FAILED" ]; then
  refuse_ship "run-evidence checks failed (${FAILED:-no checks present})"   # refuse
fi
