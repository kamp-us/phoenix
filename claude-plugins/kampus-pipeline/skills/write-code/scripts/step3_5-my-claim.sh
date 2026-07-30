#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2016
# Step 3.5's `$MY_CLAIM` resolution — the token this run owns its work under.
#
# Extracted VERBATIM from write-code/SKILL.md's "Your claim token" fenced block (epic #4435 phase 1,
# #4449). A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2
# (#1929).
#
# SOURCED, never executed — leaving $MY_CLAIM in the sourcing shell is the whole point, since
# `claim_is_mine` reads it. Sets NO shell options; no EXIT trap (under bash 3.2 a cleanup trap's
# last command becomes the script's status, laundering a `set -u` abort into exit 0 — #4476, class
# #4479). The `:` fail-closed refusal below IS this file's contract, so nothing may swallow it.
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

# the claim token this run owns work under: the orchestrator's threaded delegated token if it
# pre-claimed, else my own session id (the direct-path Step-3 self-claim). Fail-closed: with
# NEITHER set there is no agent-distinguishable identity to verify ownership under — abort, never
# fall back to the bare assignee login (that login degeneracy is the exact defect ADR 0115 removes).
MY_CLAIM="${THREADED_CLAIM_TOKEN:-$CLAUDE_CODE_SESSION_ID}"
: "${MY_CLAIM:?mis-attribution guard: no claim token — CLAUDE_CODE_SESSION_ID absent and none threaded; refusing to claim or mutate (ADR 0115 Consequences — never a login fallback)}"
