#!/usr/bin/env bash
# Step 2, second half: APPLY the release. The same `flag open` lever as the dry-run, with
# `--execute` — the one mutating call in the whole ritual. Run it only after reading the dry-run
# diff (see flag-open-dryrun.sh, which is a separate script for exactly that reason).
#
# usage: flag-open-execute.sh <flag-key> <env> [<percent>]
#
# Extracted from release/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=./lib.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

[ "$#" -ge 2 ] || { echo "usage: flag-open-execute.sh <flag-key> <env> [<percent>]" >&2; exit 2; }
FLAG_KEY="$1"; ENV="$2"; PERCENT="${3:-}"
ANKA="$(release_anka_ops_dir)" || exit 1
cd "$ANKA" || exit 1

if [ -n "$PERCENT" ]; then
  node src/bin.ts flag open "$FLAG_KEY" --percent "$PERCENT" --env "$ENV" --execute
else
  node src/bin.ts flag open "$FLAG_KEY" --env "$ENV" --execute
fi
