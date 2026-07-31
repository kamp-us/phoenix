#!/usr/bin/env bash
# The authorization gate: assert a valid founder-approval trace exists for this wave label before
# anything is recorded. REFUSES on anything else — the wave stays un-recorded.
#
# usage: verify-trace.sh <wave-label> <founder-login>
#
# The founder login is a REQUIRED argument, never defaulted: the founder identity is the
# authorization anchor, so an absent one is a refusal rather than a fall-back to any implicit login.
# Exit 0 is the ONLY proceed answer; a guard that could not run exits non-zero like a failed one.
#
# Extracted from campaign/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 2 ] || { echo "usage: verify-trace.sh <wave-label> <founder-login>" >&2; exit 2; }
WAVE_LABEL="$1"; FOUNDER="$2"
[ -n "$WAVE_LABEL" ] && [ -n "$FOUNDER" ] || { echo "campaign: REFUSED — an empty wave label or founder login is not an authorization anchor." >&2; exit 2; }
PCLI="$(kp_pcli)" || exit 127

"$PCLI" campaign verify-trace "$WAVE_LABEL" --founder "$FOUNDER" \
  || { echo "campaign: REFUSED — no valid founder-approval trace for '$WAVE_LABEL'. The wave stays un-recorded." >&2; exit 1; }
