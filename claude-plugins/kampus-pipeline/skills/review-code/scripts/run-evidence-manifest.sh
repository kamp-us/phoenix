#!/usr/bin/env bash
# Step 2 — the `present` bundle's structured results (ADR 0054 §2 fields): `checks[]` per gate step
# and the folded JUnit `tests` summary. Extracted from review-code/SKILL.md (#4451, epic #4435
# phase 1). Extraction contract: ../SKILL.md § The extracted scripts.
#
# Prints the manifest ONLY on a `present` state, exactly as the fence's `[ … ] && jq …` did — and
# says which state it saw instead when it is not `present`, so a non-`present` bundle can never be
# mistaken for an empty manifest (the four states are different facts; #3991).
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

# shellcheck disable=SC1090,SC1091
. "$(kp_scratch_path review-code-bundle)/bundle.env" || {
  echo "run-evidence-manifest.sh: no bundle state for this run — run run-evidence-read.sh first." >&2; exit 1; }
: "${BUNDLE_STATE:?run-evidence-manifest.sh: BUNDLE_STATE unset — the lookup never ran; that is \`unknown\`, not \`absent\`}"

if [ "$BUNDLE_STATE" = present ]; then
  jq '.manifest | {commit, schemaVersion, checks, tests}' <"$BUNDLE_JSON"
else
  echo "run-evidence bundle state is '$BUNDLE_STATE', not 'present' — no manifest to cite; paste \$BUNDLE_LINE verbatim into the verdict and verify from the diff + worktree run." >&2
fi
