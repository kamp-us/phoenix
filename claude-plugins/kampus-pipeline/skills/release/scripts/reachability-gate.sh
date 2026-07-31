#!/usr/bin/env bash
# Step 1.5's ADR-0173 reachability gate: hard-refuse the flip unless the flag's vertical is
# reachable (a consuming apps/web/src/**/*.tsx reference + a @journey:<key>-tagged e2e), or the key
# is stated-exempt at its keys.ts definition.
#
# usage: reachability-gate.sh <flag-key>
#   exit 0    reachable or exempt → proceed to Step 2
#   non-zero  REFUSED, or the guard could not run — either way the flag stays DARK. There is no
#             exit code and no stdout that means "proceed" other than 0, so a guard that never ran
#             cannot be read as a pass.
#
# Extracted from release/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: reachability-gate.sh <flag-key>" >&2; exit 2; }
FLAG_KEY="$1"
PCLI="$(kp_pcli)" || exit 127

# HARD-REFUSE the flip on a non-zero exit — the report (on stderr) names which assertion failed
# (no consuming UI / no journey e2e for $FLAG_KEY, or an unknown/unclassified flag). The flag
# stays dark; do NOT proceed to Step 2.
if ! "$PCLI" reachability-guard check "$FLAG_KEY"; then
  cat >&2 <<EOF
release: REFUSED — reachability gate. \`$FLAG_KEY\` is UNREACHABLE (see the reachability-guard
report above): its vertical's user-facing slice is unbuilt, so it must not graduate to 100%
(ADR 0173, epic #1943). The flag stays DARK. Build + wire the missing slice — the consuming
.tsx and/or the @journey:$FLAG_KEY-tagged e2e the report named — then re-run /release. If this
flag is UI-less by design (an infra/containment flag), mark it @reachability-exempt: <reason>
at its apps/web/src/flags/keys.ts definition; the gate then passes it.
EOF
  exit 1
fi
