#!/usr/bin/env bash
# Read a flag's EFFECTIVE serving in <env> through anka-ops — what the env actually serves today,
# resolved through rules → no-match split → default. Used for both the Step-1 pre-flight and the
# Step-3 post-flight verify.
#
# usage: flag-get.sh <flag-key> <env>
#
# Relays anka-ops' own output and exit status; it derives no release decision (ADR 0228). A
# non-zero exit means the read never landed — UNKNOWN, never "dark".
#
# Extracted from release/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=./lib.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

[ "$#" -ge 2 ] || { echo "usage: flag-get.sh <flag-key> <env>" >&2; exit 2; }
ANKA="$(release_anka_ops_dir)" || exit 1
cd "$ANKA" || exit 1
node src/bin.ts flag get "$1" --env "$2"
