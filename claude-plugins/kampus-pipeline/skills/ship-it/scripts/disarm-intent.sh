#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1091,SC2034,SC2154
# Define `disarm_intent`, the guard-6 merge-intent lifecycle primitive wired at four mandated sites (ADR 0198).
#
# Extracted VERBATIM from ship-it/SKILL.md's The no-parked-merge-intent invariant fenced block (epic #4435 phase 1, #4448).
# A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2 (#1929).
#
# SOURCED, never executed. The fenced block it replaces ran inline in the agent's shell, so this
# file deliberately sets NO shell options — several guards here depend on `pipefail` being OFF —
# and leaves its variables and functions in the sourcing shell, which is how the step's later
# blocks still see them.
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/bin/pipeline-cli"
# `merge-intent` owns the branch (ADR 0198): a live merge-queue entry is NEVER disturbed; the
# pre-queue regime — read off the BASE BRANCH's ruleset, not this PR's queue history — is exempt at
# `post-enqueue` only; and both reads fail closed toward a clear. It verifies by re-reading
# `auto_merge` — never trust
# `--disable-auto`'s exit code, which is non-zero both when the disable failed and when nothing
# was armed. Exit 1 = the intent may STILL be armed: surface it, never report a clean stop over it.
INTENT_UNCLEARED=0   # set by any failed disarm; the run's outcome line MUST carry it (see Running it)
disarm_intent() {   # $1 = preflight | refuse | post-enqueue | ejected
  "$PCLI" merge-intent disarm --pr "$PR" --repo "$REPO" --site "$1" || {
    echo "ship-it: FAILED to clear the merge intent on #$PR (site $1) — a later approval could enqueue it ungated (ADR 0198). Disable auto-merge by hand before this PR is approved again." >&2
    return 1
  }
}

# Site 1 — run start. This function is DEFINED here; the call itself is WIRED at Step 0, on the
# line after `PR=` — the first point at which both $PR and $REPO exist (see "Step 0 — Classify the
# diff"). Do not call it here: this block is preamble and runs before Step 0 resolves $PR.
