#!/usr/bin/env bash
# Print the ADR map: the `NNNN-slug.md` filenames (the map itself, ADR 0129), then the compact
# `id · title · status` index the verb generates from the same directory.
#
# Extracted from architecture-audit/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

[ -d .decisions ] || { echo "architecture-audit: no .decisions/ from $(pwd) — run from the repo root." >&2; exit 1; }
PCLI="$(kp_pcli)" || exit 127

ls .decisions/                    # the map — one NNNN-slug.md per ADR
"$PCLI" decisions-index compact   # the compact id · title · status map
