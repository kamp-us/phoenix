#!/usr/bin/env bash
# Step 4d's reference-anchored sub-loop input: the blessed surface-ids from the committed pointer.
#
# usage: step4d-blessed-surfaces.sh
#
# stdout is `POINTER=<path>` followed by one blessed surface-id per line. An EMPTY id list ⇒ no
# blessed surface changed ⇒ the whole sub-loop is a no-op and the plain pillars loop stands.
#
# The carried-over `|| true` resolves an unreadable/absent pointer to an EMPTY blessed set, which the
# step reads as that same no-op. That is correct for a genuinely absent pointer (the graceful-absence
# contract) and fail-OPEN for an unreadable one; carried as-is per ADR 0228 and tracked in #4501.
#
# Executed, never sourced (ADR 0232) — `$POINTER` / `$BLESSED_SURFACES` used to land in the sourcing
# shell.
# shellcheck disable=SC1007,SC1091,SC2016
set -uo pipefail
# shellcheck source=../../../lib/common.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

# blessed surface-ids: the keys of the committed pointer's `surfaces` map (ADR 0183).
# Intersect with the surfaces THIS diff renders (Step 4d capture) — only that ∩ is reference-anchored.
# Empty ∩ ⇒ no blessed surface changed ⇒ this whole sub-loop is a no-op; the plain pillars loop stands.
POINTER=packages/design-capture/golden-pointer.json
BLESSED_SURFACES="$(jq -r '.surfaces | keys[]' "$POINTER" 2>/dev/null || true)"
printf 'POINTER=%s\n' "$POINTER"
[ -n "$BLESSED_SURFACES" ] && printf '%s\n' "$BLESSED_SURFACES"
exit 0
