#!/usr/bin/env bash
# Upsert the `review-design` verdict comment through the guarded emit path, and print the comment
# id. Keyed on (PR, gate-namespace, head, run) — see ADR 0213 — so it replaces only this head+run's
# own prior marker and appends against any other key; fails loud on a malformed
# marker — the verdict tool refuses fail-closed before landing unless every SHA field is a clean
# full 40-hex head SHA (#2683).
#
# usage: verdict-upsert.sh <pr> <verdict-body-file>
#
# Extracted from review-design/SKILL.md (#4453, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 2 ] || { echo "usage: verdict-upsert.sh <pr> <verdict-body-file>" >&2; exit 2; }
PR="$1"; BODY_FILE="$2"
# The `bin/pipeline-cli` shim decides WHICH build runs — in-repo bin, else the installed bin, else
# the pinned `pnpm dlx` fallback reading the one pin (hooks/pin.sh); no version pinned here (#3653;
# ADR 0062/0064; epic #994).
PCLI="$(kp_pcli)" || exit 127

out="$("$PCLI" verdict post --pr "$PR" --gate design --body-file "$BODY_FILE")" || exit 1
printf '%s\n' "$out" | awk '{print $2}'   # `posted <id>` / `patched <id>` → the comment id
