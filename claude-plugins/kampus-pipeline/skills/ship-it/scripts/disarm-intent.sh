#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2034
# Define `disarm_intent`, the guard-6 merge-intent lifecycle primitive wired at four mandated sites (ADR 0198).
#
# Extracted VERBATIM from ship-it/SKILL.md's The no-parked-merge-intent invariant fenced block (epic #4435 phase 1, #4448).
# A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2 (#1929).
#
# DUAL-MODE (ADR 0232) — the why is `.patterns/skill-script-shell-shape.md` § The dual-mode shape.
#   EXECUTED:  bash ./claude-plugins/kampus-pipeline/skills/ship-it/scripts/disarm-intent.sh \
#                   <REPO> <PR> <preflight|refuse|post-enqueue|ejected>
#              stdout ⇒ one line, `INTENT_UNCLEARED=0` (the intent is provably clear) or
#              `INTENT_UNCLEARED=1` (it may STILL be armed — the run's outcome line MUST carry it).
#              The exit status matches, so a caller may read either. `INTENT_UNCLEARED` is the one
#              value the sourced form left in the caller's shell that no longer crosses a process
#              boundary, so it is relayed on stdout instead.
#   SOURCED:   the sanctioned in-script edge, and why the function below is untouched. Nine ship-it
#              step scripts source this file for `disarm_intent`, which the SKILL.md preamble used to
#              leave in the agent's shell for the whole chain; a process cannot inherit a function,
#              so each caller now pulls it in itself. `verify-chain-resolves.sh` sources it too.
# No EXIT trap — under bash 3.2 a cleanup trap's last command becomes the script's status,
# laundering a `set -u` abort into exit 0 (#4476, class #4479).

if [ "${BASH_SOURCE[0]}" = "$0" ]; then set -uo pipefail; fi   # executed mode only (ADR 0232)
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/bin/pipeline-cli"
# `merge-intent` owns the branch (ADR 0198): a live merge-queue entry is NEVER disturbed; the
# pre-queue regime — read off the BASE BRANCH's ruleset, not this PR's queue history — is exempt at
# `post-enqueue` only; and both reads fail closed toward a clear. It verifies by re-reading
# `auto_merge` — never trust
# `--disable-auto`'s exit code, which is non-zero both when the disable failed and when nothing
# was armed. Exit 1 = the intent may STILL be armed: surface it, never report a clean stop over it.
# `:-0` rather than a bare `0`: nine step scripts now source this file in-chain, so the assignment
# runs more than once per run. A bare `0` would reset a 1 an earlier disarm had already recorded, and
# the run would report a clean stop over an intent that may still be armed — the exact failure the
# variable exists to surface. A fresh shell still starts at 0.
INTENT_UNCLEARED="${INTENT_UNCLEARED:-0}"   # set by any failed disarm; the run's outcome line MUST carry it (see Running it)
disarm_intent() {   # $1 = preflight | refuse | post-enqueue | ejected
  "$PCLI" merge-intent disarm --pr "$PR" --repo "$REPO" --site "$1" || {
    echo "ship-it: FAILED to clear the merge intent on #$PR (site $1) — a later approval could enqueue it ungated (ADR 0198). Disable auto-merge by hand before this PR is approved again." >&2
    return 1
  }
}

# Site 1 — run start. This function is DEFINED here; the call itself is WIRED at Step 0, on the
# line after `PR=` — the first point at which both $PR and $REPO exist (see "Step 0 — Classify the
# diff"). Do not call it here in SOURCED mode: that path is preamble and runs before Step 0
# resolves $PR. The executed entry below is a different caller — it is handed both.

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  REPO="${REPO:-${1:?disarm-intent.sh: no <REPO> argument — refusing to disarm an intent on an unnamed repo}}"
  PR="${PR:-${2:?disarm-intent.sh: no <PR> argument — refusing to disarm an intent on an unnamed PR}}"
  # The status answers "could I clear it", and the printed line carries the same fact for the ledger
  # (`.patterns/skill-script-shell-shape.md` § The dual-mode shape rule 4). A failed disarm is a
  # 1 to REPORT, never a reason to print nothing.
  if disarm_intent "${3:?disarm-intent.sh: no <site> argument — refusing to disarm at an unnamed site}"; then
    echo "INTENT_UNCLEARED=0"
  else
    echo "INTENT_UNCLEARED=1"; exit 1
  fi
fi
