#!/usr/bin/env bash
# Hand the gathered entries array to the `ship-digest derive` verb, which owns the readout derivation.
# This script relays the verb; it derives nothing itself (ADR 0228).
#
# usage: derive-digest.sh <entries.json> <since> <until>
#
# The entries file is REQUIRED and must be non-empty: an absent or empty file would hand the verb a
# zero-entry array, which reads as "nothing shipped in the window" — a well-formed, plausible,
# always-wrong readout. That is a refusal here, not a digest.
#
# Extracted from what-shipped/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 3 ] || { echo "usage: derive-digest.sh <entries.json> <since> <until>" >&2; exit 2; }
ENTRIES="$1"
[ -s "$ENTRIES" ] || { echo "what-shipped: entries file '$ENTRIES' is missing/empty — refusing to derive a digest from no entries." >&2; exit 2; }
PCLI="$(kp_pcli)" || exit 127

"$PCLI" ship-digest derive --entries "$ENTRIES" --since "$2" --until "$3"
