#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2016,SC2034
# Landed-comment leak scan — refuse to enqueue a PR whose comments carry a machine-local path (guard 4).
#
# Extracted VERBATIM from ship-it/SKILL.md's Step 3.7 fenced block (epic #4435 phase 1, #4448).
# A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2 (#1929).
#
# DUAL-MODE (ADR 0232) — the why is `.patterns/skill-script-shell-shape.md` § The dual-mode shape.
#   EXECUTED:  bash ./claude-plugins/kampus-pipeline/skills/ship-it/scripts/step3_7-leak-scan.sh <REPO> <PR>
#              stdout ⇒ `LEAK_SCAN=clean` when guard 4 clears — the positive token, because this
#              guard's clean answer is otherwise SILENCE and silence is also what a run that never
#              happened looks like (§ZS). A leak, or an unresolved shim, names itself on stderr,
#              prints `INTENT_UNCLEARED=<0|1>`, and exits 1. The EXIT STATUS is the gate.
#   SOURCED:   no in-script consumer today; the edge stays open for one.
# No EXIT trap — under bash 3.2 a cleanup trap's last command becomes the script's status,
# laundering a `set -u` abort into exit 0 (#4476, class #4479), which would silently disarm guard 4.

if [ "${BASH_SOURCE[0]}" = "$0" ]; then set -uo pipefail; fi   # executed mode only (ADR 0232)
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"
# `disarm_intent` (guard 6 / ADR 0198), sourced IN-CHAIN — a process inherits no functions (ADR 0232).
# shellcheck source=disarm-intent.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/." && pwd)/disarm-intent.sh"

# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/bin/pipeline-cli"
REPO="${REPO:-${1:?step3_7-leak-scan.sh: REPO unset and no \$1 — refusing to scan an unnamed repo}}"
PR="${PR:-${2:?step3_7-leak-scan.sh: PR unset and no \$2 — refusing to scan an unnamed PR}}"
# …and prove it resolved BEFORE the guard runs. Without this the `||` below fires on a 127 too,
# and reports "a landed comment carries a machine-local path" for a CLI that never ran (#3314).
[ -x "$PCLI" ] || {
  disarm_intent refuse || INTENT_UNCLEARED=1
  echo "ship-it: REFUSING to enqueue #$PR — leak-guard is UNRESOLVED at '$PCLI', so the leak scan has NO result (§CLI: could-not-run is UNKNOWN, never clean)." >&2
  if [ "${BASH_SOURCE[0]}" = "$0" ]; then printf 'INTENT_UNCLEARED=%s\n' "$INTENT_UNCLEARED"; fi
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
  if [ "${BASH_SOURCE[0]}" = "$0" ]; then printf 'INTENT_UNCLEARED=%s\n' "$INTENT_UNCLEARED"; fi
  exit 1
}
# The positive clean token — guard 4's ordinary answer is otherwise no output at all, and §SHARED's
# reader must never have to infer "clean" from an absence (rule 4 / §ZS).
if [ "${BASH_SOURCE[0]}" = "$0" ]; then echo "LEAK_SCAN=clean"; fi
