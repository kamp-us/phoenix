#!/usr/bin/env bash
# Acquire the two-layer `status:planning` epic-lock on <EPIC> before you create, amend, supersede,
# unlink, or close any child — and before the Step-5 body PATCH (ADR 0059/0115). The *why* — why
# the coarse label alone cannot serialize under one shared login, and why every back-off must not
# fall through to a mutation — stays in ../SKILL.md § Acquire the epic-lock.
#
# usage: epic-lock-acquire.sh <EPIC>
#
# EXIT-CODE CONTRACT — the back-off seam. The moved block ended its back-off with `exit 0`, which
# terminated the AGENT's own bash block; a separate process cannot do that, and an exit 0 here
# would read to the caller as "the lock is ours". So the back-off became its own code:
#   0    WON — we hold the lock (label + earliest claim). RELEASE it on every terminal path.
#   3    backed off (held label / 422 missing label / failed claim post / lost co-acquire /
#        missing session id). NOT a plan-epic failure — re-run later; never mutate.
#   127  the shim never ran — UNKNOWN, so NOT a win.
# Exit 0 is reachable only through `epic-lock acquire` itself exiting 0, and stdout carries the
# `epic-lock: won` line on that one path only — so neither an empty stdout nor a could-not-run
# can be read as the permissive answer.
#
# Extracted from plan-epic/SKILL.md (#4452, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: epic-lock-acquire.sh <EPIC>" >&2; exit 2; }
EPIC="$1"
# The `bin/pipeline-cli` shim resolves the CLI (in-repo bin, else the installed bin, else the
# pinned `pnpm dlx` fallback reading hooks/pin.sh) — no version pinned here (#3653; ADR 0064).
PCLI="$(kp_pcli)" || exit 127
LOCK="$PCLI epic-lock"

# Acquire the two-layer lock. `epic-lock acquire` runs the WHOLE ADR-0115 protocol over $CLAUDE_CODE_SESSION_ID
# and exits 0 ONLY when the lock is ours; every fail-closed back-off — a held label, a 422 missing label, a
# failed claim post, a lost co-acquire, a missing session id — prints its reason on stderr and exits NON-ZERO.
# Branch on exit status — never mutate on a non-zero.
if ! $LOCK acquire "$EPIC"; then
  echo "epic-lock: backed off on #$EPIC (held lock / setup gap / lost race is not a plan-epic failure) — re-run later." >&2
  exit 3
fi
# WON. WE hold the lock (label + earliest claim). Release it on EVERY terminal path (below).
echo "epic-lock: won #$EPIC"
