#!/usr/bin/env bash
# Step 3f — the session-caching seam scan (ADR 0169), plus the §ZS #1 scope line. Extracted from
# review-code/SKILL.md (#4451, epic #4435 phase 1). Extraction contract:
# ../SKILL.md § The extracted scripts.
#
# A hit ARMS the two-axis check; it never alone FAILs — the reviewer judges whether a hit is a
# genuine new caching path or an unrelated auth edit, and the candidate lines go to stdout after the
# scope line so that judgement has the evidence the fence left in `$CACHE_HITS`. Fail-closed on this
# security-load-bearing surface: when in doubt that a hit is a caching path, run the check, don't
# skip it — so a usage error prints nothing and exits non-zero rather than a reassuring zero count.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: session-caching-scan.sh <pr>" >&2; exit 2; }
PR="$1"

# does this PR touch a session/caching seam? A hit ARMS the two-axis check below; it never
# alone FAILs — the reviewer judges whether a hit is a genuine new caching path (per the fire
# condition above) or an unrelated auth edit. Fail-closed on the security-load-bearing surface:
# when in doubt that a hit is a caching path, run the check, don't skip it.
CACHE_HITS="$(gh pr diff "$PR" \
  | grep -inE 'cookieCache|session\.?cache|cacheSession|maxAge|staleness|ttl|revalidat' || true)"
echo "session-caching gate: scanned the diff for session-caching seams — $(printf '%s\n' "$CACHE_HITS" | grep -c . || echo 0) candidate line(s)"
printf '%s\n' "$CACHE_HITS"
