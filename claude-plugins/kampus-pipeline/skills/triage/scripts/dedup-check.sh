#!/usr/bin/env bash
# Step 1's intake-dedup read (ADR 0181): print one `#<n>\t<title>` line per open issue that may
# already cover this observation. The verb resolves the target repo itself, so no $REPO is needed.
#
# usage: dedup-check.sh <query> <N>
#
# stdout is the verb's own output RELAYED unchanged (ADR 0228) — this script derives nothing. An
# empty stdout means "no likely duplicate" ONLY on exit 0; every failure path here exits non-zero
# (2 usage, 127 CLI unresolved, else the verb's own status) so an unrun check can never read as a
# clean one.
#
# Extracted from triage/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 2 ] || { echo "usage: dedup-check.sh <query> <N>" >&2; exit 2; }
PCLI="$(kp_pcli)" || exit 127

"$PCLI" intake-dedup check \
  --query "$1" \
  --exclude "$2"
