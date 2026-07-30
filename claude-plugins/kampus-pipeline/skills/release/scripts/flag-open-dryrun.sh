#!/usr/bin/env bash
# Step 2, first half: the DRY-RUN flip. Reads current state, prints the `current → target` diff, and
# writes NOTHING — `flag open` is dry-run by default and this script never passes `--execute`.
#
# usage: flag-open-dryrun.sh <flag-key> <env> [<percent>]
#   with no <percent>: the full release (a bare `flag open` ≡ --percent 100)
#   with <percent>:    the ramped release — serve `on` to N% of traffic, remainder falls to the
#                      safe default
#
# The dry-run and the apply are two SEPARATE scripts, deliberately: the two-step is the safety, so
# `--execute` can never arrive as a defaulted or mistyped flag on the script that prints the diff.
#
# Extracted from release/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=./lib.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

[ "$#" -ge 2 ] || { echo "usage: flag-open-dryrun.sh <flag-key> <env> [<percent>]" >&2; exit 2; }
FLAG_KEY="$1"; ENV="$2"; PERCENT="${3:-}"
ANKA="$(release_anka_ops_dir)" || exit 1
cd "$ANKA" || exit 1

if [ -n "$PERCENT" ]; then
  node src/bin.ts flag open "$FLAG_KEY" --percent "$PERCENT" --env "$ENV"
else
  node src/bin.ts flag open "$FLAG_KEY" --env "$ENV"
fi
