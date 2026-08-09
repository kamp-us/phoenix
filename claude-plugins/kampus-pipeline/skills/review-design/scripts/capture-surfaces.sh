#!/usr/bin/env bash
# Drive the `@kampus/fabrika-cli/capture` helper over the preview deploy (the seam; #2247 owns the
# Playwright + upload mechanics) and print its stdout JSON array of
# { surface, route, state, localPath, hostedUrl, uploadError, pageErrors }.
#
# usage: capture-surfaces.sh <preview-url> <surface> [<surface> …]      surface = <route>[:state]
#
# Extracted from review-design/SKILL.md (#4453, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 2 ] || { echo "usage: capture-surfaces.sh <preview-url> <surface> [<surface> ...]" >&2; exit 2; }
PREVIEW_URL="$1"; shift
REPO="$(kp_repo)" || exit 1

# One `--surface <id>` pair per remaining argument. The count is checked before the expansion
# because on bash 3.2 an empty array expanded with a `-` default yields ONE EMPTY ARGUMENT rather
# than nothing — which would hand the helper an empty surface id instead of skipping.
SURFACE_ARGS=()
for surface in "$@"; do
	SURFACE_ARGS+=(--surface "$surface")
done
[ "${#SURFACE_ARGS[@]}" -gt 0 ] || { echo "capture-surfaces.sh: no surfaces given — nothing to capture." >&2; exit 2; }

OUT="$(mktemp -d)"
node packages/design-capture/src/bin.ts capture \
  --preview-url "$PREVIEW_URL" \
  "${SURFACE_ARGS[@]}" \
  --out "$OUT" \
  --repo-id "$(gh api "repos/$REPO" --jq .id)"
