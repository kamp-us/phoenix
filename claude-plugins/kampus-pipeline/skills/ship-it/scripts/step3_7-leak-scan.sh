#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1091,SC2034,SC2154
# Landed-comment leak scan — refuse to enqueue a PR whose comments carry a machine-local path (guard 4).
#
# Extracted VERBATIM from ship-it/SKILL.md's Step 3.7 fenced block (epic #4435 phase 1, #4448).
# A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2 (#1929).
#
# SOURCED, never executed. The fenced block it replaces ran inline in the agent's shell, so this
# file deliberately sets NO shell options — several guards here depend on `pipefail` being OFF —
# and leaves its variables and functions in the sourcing shell, which is how the step's later
# blocks still see them.
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/bin/pipeline-cli"
# …and prove it resolved BEFORE the guard runs. Without this the `||` below fires on a 127 too,
# and reports "a landed comment carries a machine-local path" for a CLI that never ran (#3314).
[ -x "$PCLI" ] || {
  disarm_intent refuse || INTENT_UNCLEARED=1
  echo "ship-it: REFUSING to enqueue #$PR — leak-guard is UNRESOLVED at '$PCLI', so the leak scan has NO result (§CLI: could-not-run is UNKNOWN, never clean)." >&2
  exit 1
}
# guard 4 — refuse the enqueue on ANY live leak in a landed comment (exit 2 = a leak; ADR 0092 fail-closed)
"$PCLI" leak-guard scan-pr "$PR" || {
  disarm_intent refuse || INTENT_UNCLEARED=1   # guard 6: a refusal parks nothing (ADR 0198)
  echo "ship-it: REFUSING to enqueue #$PR — a landed comment carries a machine-local path (issue #3019)." >&2
  echo "  Remediate, then re-run ship-it:" >&2
  echo '  1. redact each flagged comment body — `$PCLI redact-leaks` (the merged #3021 tool) preserves evidential shape;' >&2
  echo '  2. re-post the redacted body (a verdict via `$PCLI verdict post`, which now self-verifies the landed comment, #3019);' >&2
  echo "  3. the underlying issue is a bypassed emit path — route the PR back to repair so the leaking comment is re-emitted through the mandated choke point." >&2
  exit 1
}
