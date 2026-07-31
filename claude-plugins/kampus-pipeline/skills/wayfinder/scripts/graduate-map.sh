#!/usr/bin/env bash
# Close a FULLY-graduated map: post the `Graduated into <artifact>` source → artifact provenance
# record and close the source as completed. The `tracker graduate` verb owns this envelope (ADR 0190,
# #3266) — this script relays it and derives nothing (ADR 0228).
#
# usage: graduate-map.sh <map> <artifact> <note>
#
# FULLY-graduated only. A partial graduation is annotated with a plain comment and stays OPEN, so it
# does not come through here.
#
# Extracted from wayfinder/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 3 ] || { echo "usage: graduate-map.sh <map> <artifact> <note>" >&2; exit 2; }
PCLI="$(kp_pcli)" || exit 127

"$PCLI" tracker graduate "$1" \
  --artifact "$2" \
  --note "$3"
