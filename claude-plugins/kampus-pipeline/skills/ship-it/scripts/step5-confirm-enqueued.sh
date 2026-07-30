#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2034,SC2086
# Confirm the PR is enqueued and green (QUEUED is the success shape, not merged).
#
# Extracted VERBATIM from ship-it/SKILL.md's Step 5 fenced block (epic #4435 phase 1, #4448).
# A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2 (#1929).
#
# SOURCED, never executed. The fenced block it replaces ran inline in the agent's shell, so this
# file deliberately sets NO shell options — several guards here depend on `pipefail` being OFF —
# and leaves its variables and functions in the sourcing shell, which is how the step's later
# blocks still see them.
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/bin/pipeline-cli"
# The QUEUED signal is the success condition. `already queued to merge` from Step 4's --auto
# and/or an `enqueued`/QUEUED mergeStateStatus confirm it — NOT a non-null auto_merge, which
# under the queue stays null on a clean enqueue (ADR 0132 §3).
gh api repos/$REPO/pulls/$PR --jq '{merged, auto_merge, mergeable_state}'
gh pr view $PR --json mergeStateStatus --jq '{mergeStateStatus}'
# Confirm queue membership through the SAME verb Step 5.5's reconcile polls — never a second,
# hand-rolled timeline read here (#4193). Prints exactly one of merged/queued/pending/ejected.
# An unresolved CLI prints nothing, and an empty QUEUE_STATE is not a state — refuse rather than
# branch on it (§CLI: could-not-run is UNKNOWN, never a queue outcome; #3314).
[ -x "$PCLI" ] || { echo "ship-it: merge-queue-classify is UNRESOLVED at '$PCLI' — queue membership is UNKNOWN, not confirmed." >&2; exit 1; }
QUEUE_STATE=$("$PCLI" merge-queue-classify classify --pr "$PR" --repo "$REPO")
