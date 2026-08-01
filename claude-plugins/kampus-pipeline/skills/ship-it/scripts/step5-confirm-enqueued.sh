#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2034,SC2086
# Confirm the PR is enqueued and green (QUEUED is the success shape, not merged).
#
# Extracted VERBATIM from ship-it/SKILL.md's Step 5 fenced block (epic #4435 phase 1, #4448).
# A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2 (#1929).
#
# DUAL-MODE (ADR 0232) — the why is `.patterns/skill-script-shell-shape.md` § The dual-mode shape.
#   EXECUTED:  bash ./claude-plugins/kampus-pipeline/skills/ship-it/scripts/step5-confirm-enqueued.sh <REPO> <PR>
#              stdout ⇒ the two REST/porcelain state objects, then `QUEUE_STATE=<merged|queued|
#              pending|ejected>`. That last line is the answer; an unresolved shim prints no
#              `QUEUE_STATE=` line at all, names itself on stderr, and exits 1 — could-not-run is
#              UNKNOWN, never a queue outcome.
#   SOURCED:   no in-script consumer today; the edge stays open for one.
# No EXIT trap — under bash 3.2 a cleanup trap's last command becomes the script's status,
# laundering a `set -u` abort into exit 0 (#4476, class #4479).

if [ "${BASH_SOURCE[0]}" = "$0" ]; then set -uo pipefail; fi   # executed mode only (ADR 0232)
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/bin/pipeline-cli"
REPO="${REPO:-${1:?step5-confirm-enqueued.sh: REPO unset and no \$1 — refusing to confirm an enqueue in an unnamed repo}}"
PR="${PR:-${2:?step5-confirm-enqueued.sh: PR unset and no \$2 — refusing to confirm an enqueue for an unnamed PR}}"
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
if [ "${BASH_SOURCE[0]}" = "$0" ]; then printf 'QUEUE_STATE=%s\n' "$QUEUE_STATE"; fi
