#!/usr/bin/env bash
# Step 3b — the linked issue's `**Containment:**` marker, read tolerantly (formats §2). Prints
# exactly one of `flag` | `exempt` | `none`; a missing line reads as `none`. Extracted from
# review-code/SKILL.md (#4451, epic #4435 phase 1). Extraction contract:
# ../SKILL.md § The extracted scripts.
#
# `none` is the SKIP answer, so it is the permissive one here — every path that returns before the
# read completes must NOT print it. On a usage error or an unresolvable repo this prints `flag`
# instead and exits non-zero: an unread marker is UNKNOWN, and holding UNKNOWN at the ARMED value
# means the gating verification runs rather than being silently skipped (§ZS / ADR 0092). The
# fail-closed direction differs from the classifiers above because here the *armed* state is the
# conservative one.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo flag; echo "usage: containment-marker.sh <issue>" >&2; exit 2; }
ISSUE="$1"
REPO="$(kp_repo)" || { echo flag; echo "containment-marker.sh: target repo unresolved — marker UNKNOWN, held ARMED (flag)." >&2; exit 1; }

# the linked issue's containment marker; a missing line reads as `none` (formats §2 tolerant-read rule)
CONTAINMENT=$(gh api repos/"$REPO"/issues/"$ISSUE" --jq '.body' \
  | grep -ioE '\**\s*Containment:\**\s*(flag|exempt|none)' | head -n1 \
  | grep -ioE '(flag|exempt|none)' || echo none)
printf '%s\n' "$CONTAINMENT"
