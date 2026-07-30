#!/usr/bin/env bash
# Open the PR that records the campaign in ROADMAP.md's `## Campaigns` table.
#
# usage: open-roadmap-pr.sh <campaign name> <active|done> <branch> <wave-label> <milestone-number> <tracking-issue>
#
# The branch + the ROADMAP.md edit + the commit are NOT here on purpose: a script that ran
# `git switch -c` would mutate whichever checkout the caller happened to be sitting in, which is a
# footgun the extraction would have introduced rather than moved (the primary-checkout mis-branch
# class). Those stay explicit steps in the skill; this script only opens the PR.
#
# Extracted from campaign/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

[ "$#" -ge 6 ] || { echo "usage: open-roadmap-pr.sh <campaign name> <active|done> <branch> <wave-label> <milestone-number> <tracking-issue>" >&2; exit 2; }
NAME="$1"; STATE="$2"; BRANCH="$3"; WAVE_LABEL="$4"; MILESTONE_NUMBER="$5"; TRACKING="$6"
case "$STATE" in active | done) ;; *) echo "open-roadmap-pr: state must be 'active' or 'done', got '$STATE'." >&2; exit 2 ;; esac
REPO="$(kp_repo)" || exit 1

gh api -X POST "repos/$REPO/pulls" \
  -f "title=roadmap: record $NAME campaign ($STATE)" \
  -f "head=$BRANCH" -f "base=main" \
  -f "body=Records the $NAME audit wave (\`$WAVE_LABEL\`) as a bounded campaign — milestone #$MILESTONE_NUMBER, p1, platform-lane drained. Founder-approval trace verified. Fixes #$TRACKING."
