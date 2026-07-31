#!/usr/bin/env bash
# Step 4: open the per-run scratch namespace for #N, fetch the issue's ORIGINAL body into it, and
# redact any machine-local path leak before that original goes into the `<details>` block. Prints
# the scratch directory so the caller can compose `body.md` there.
#
# usage: fetch-original.sh <N>
#   writes  <scratch>/original.md           the raw original
#           <scratch>/original.redacted.md  the leak-redacted original — assemble <details> FROM THIS
#
# The §SP namespace (../../gh-issue-intake-formats.md §SP) is keyed on the session id, not a bare
# `mktemp -d`, because patch-body.sh runs in a LATER Bash call where every shell variable is gone
# and must re-derive this same directory. Both scripts go through the ONE shared `kp_scratch_*`
# seam so they cannot disagree about the path (#3718). `open` resets; `path` never does.
#
# Extracted from triage/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: fetch-original.sh <N>" >&2; exit 2; }
N="$1"
REPO="$(kp_repo)" || exit 1
PCLI="$(kp_pcli)" || exit 127
RUN_SCRATCH="$(kp_scratch_open "triage-$N")" || exit 1

gh api "repos/$REPO/issues/$N" --jq '.body' > "$RUN_SCRATCH/original.md" || exit 1
# redact any machine-local path leak in the ORIGINAL before it goes into <details>; leak-free
# originals pass through byte-for-byte. Reuses the shared leak matcher — no divergent patterns.
"$PCLI" redact-leaks --body-file "$RUN_SCRATCH/original.md" > "$RUN_SCRATCH/original.redacted.md" || exit 1
# assemble the <details> block from the REDACTED original, never the raw one
printf '%s\n' "$RUN_SCRATCH"
