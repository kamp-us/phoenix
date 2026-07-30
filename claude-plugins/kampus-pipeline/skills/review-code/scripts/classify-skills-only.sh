#!/usr/bin/env bash
# Step 2 — the skills-only off-ramp (ADR 0073 supersedes 0063's `skills/**` → review-code routing).
# Prints `not a code PR — route to review-skill` and exits 0 ONLY on a proven skills-only diff;
# prints nothing and exits 0 when the PR carries code. Extracted from review-code/SKILL.md (#4451,
# epic #4435 phase 1). Extraction contract + shell-option rationale:
# ../SKILL.md § The extracted scripts.
#
# The off-ramp line is the answer that STOPS the code gate, so it is the permissive one here: every
# path that returns before the predicate runs prints `CANNOT-CLASSIFY (…)` instead and exits
# non-zero, and the caller reads the status before the stdout. A classifier that could not run is
# UNKNOWN, and UNKNOWN is never "no code to gate" (§ZS / ADR 0092; #4231, #4010, #4219). The `FILES=`
# read needs no separate sentinel: gh writes its error document to STDOUT, so a failed read leaves a
# non-`skills/`-prefixed line in `$OFFCLASS` and the predicate correctly refuses the off-ramp.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"
# §WL's `kp_wl_all_onclass` — the empty-output form of "every changed path is under skills/ or
# agents/", sourced from its canonical home rather than re-copied (#4489 extracted it out of
# ../../gh-issue-intake-formats.md). Never `! grep -qv`: a false-true there `exit 0`s the code gate
# on a PR that does carry code (§WL, #4155).
# shellcheck source=../../shared/scripts/wl-empty-output.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/scripts" && pwd)/wl-empty-output.sh"

[ "$#" -ge 1 ] || {
	echo "CANNOT-CLASSIFY (no <pr> argument — artifact class UNKNOWN, never an off-ramp)"
	echo "usage: classify-skills-only.sh <pr>" >&2
	exit 2
}
PR="$1"
REPO="$(kp_repo)" || {
	echo "CANNOT-CLASSIFY (target repo unresolved — artifact class UNKNOWN, never an off-ramp)"
	exit 1
}

# the file set drives the class decision (same list Step 2 pulled)
# shellcheck disable=SC2034  # read by the sourced kp_wl_all_onclass, which takes $FILES from the caller
FILES="$(gh api --paginate "repos/$REPO/pulls/$PR/files?per_page=100" --jq '.[].filename')"   # --paginate + streaming --jq: full set past file #100 (the API caps per_page at 100; #725)
# skills-only ⇒ every changed path is under skills/ or agents/ — review-skill's class, not yours
# (agents/** are behavioral artifacts, review-skill-routed for the verdict — ADR 0150/#2003).
if kp_wl_all_onclass; then
  echo "not a code PR — route to review-skill"   # plain note, no review-code: marker; stop
  exit 0
fi
