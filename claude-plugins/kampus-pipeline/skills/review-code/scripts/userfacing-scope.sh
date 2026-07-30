#!/usr/bin/env bash
# Step 3b — the flag-gating user-facing scope scan, and the §ZS zero-scope FAIL. Extracted from
# review-code/SKILL.md (#4451, epic #4435 phase 1). Extraction contract:
# ../SKILL.md § The extracted scripts. The *why* the reachable surface is exactly
# `apps/web/src/**/*.{tsx,css}` + new `apps/web/worker/**` entry points stays in that step's prose.
#
# Prints the scope line, the matched paths, and — on zero matches — the one `[FAIL]` row. NO match is
# the FAIL here, so "printed nothing" can never read as a pass; but a scan that could not RUN must not
# read as either, so a usage error or an unresolvable repo prints the same `[FAIL]` row and exits
# non-zero (§ZS / ADR 0092: a relevant-input gate with zero evidence fails closed, and UNKNOWN is
# never a pass).
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

# shellcheck disable=SC2016  # the `**Containment:** flag` / `apps/web/src/**` text is literal verdict prose, not an expansion
ZERO_ROW='- [FAIL] flag-gating (default-off) — `**Containment:** flag` marks a dark-shipped feature, but the diff touches NO user-facing surface (apps/web/src/**/*.{tsx,css}, new apps/web/worker/** resolver/route/mutation): empty scope on a flag-marked PR is a FAIL (ADR 0092 §ZS), not a pass — there is no user-facing path to gate.'

[ "$#" -ge 1 ] || { printf '%s\n' "$ZERO_ROW"; echo "usage: userfacing-scope.sh <pr>" >&2; exit 2; }
PR="$1"
REPO="$(kp_repo)" || { printf '%s\n' "$ZERO_ROW"; echo "userfacing-scope.sh: target repo unresolved — scope UNKNOWN, failing closed." >&2; exit 1; }

# the PR's user-facing surface (reachable UI + new data/API entry points), off the changed file set.
# Emit the count + matched paths (ADR 0092 §ZS #1 — a gate states its scope), then fail closed on zero.
FILES="$(gh api --paginate "repos/$REPO/pulls/$PR/files?per_page=100" --jq '.[].filename')"   # the changed paths (same set Step 2 pulled; --paginate past file #100, #725)
USERFACING=$(printf '%s\n' "$FILES" | grep -E '^apps/web/src/.*\.(tsx|css)$|^apps/web/worker/.*\.(ts|tsx)$' || true)
USERFACING_N=$(printf '%s\n' "$USERFACING" | grep -c . || true)
echo "flag-gating user-facing scope: $USERFACING_N path(s) matched"; printf '%s\n' "$USERFACING"
if [ "$USERFACING_N" -eq 0 ]; then
  # relevant input (flag marker present), zero matches ⇒ FAIL CLOSED, never a silent PASS (§ZS #2).
  # Emit ONE [FAIL] row into the conjunctive verdict; the PR is not merge-ready.
  echo "- [FAIL] flag-gating (default-off) — \`**Containment:** flag\` marks a dark-shipped feature, but the diff touches NO user-facing surface (apps/web/src/**/*.{tsx,css}, new apps/web/worker/** resolver/route/mutation): empty scope on a flag-marked PR is a FAIL (ADR 0092 §ZS), not a pass — there is no user-facing path to gate."
fi
