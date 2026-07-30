#!/usr/bin/env bash
# §Milestone — the REST surface, extracted from `gh-issue-intake-formats.md` (epic #4435 phase 1,
# #4450). The *why* — what a milestone IS, who writes it, why `none` is a first-class answer, and why
# assignment is by numeric id and never the title — stays in that contract's §Milestone prose
# (ADR 0072).
#
# MECHANICAL MOVE. Each command below is byte-identical to the fence line it came from, with the
# prose metavariables bound to positional parameters (`<N>` -> "$1", `<milestone-number>` -> the
# milestone argument) — the one seam a non-runnable placeholder recipe needs to become runnable.
# Verbification is phase 2 (#1929, ADR 0228). Do not "improve" it here.
#
# Sourced, never executed: it defines functions and sets no shell options, so the caller keeps its own
# `set -euo pipefail`. Reads $REPO from the caller. No EXIT trap — under bash 3.2 a cleanup trap's
# last command becomes the script's status, laundering a `set -u` abort into exit 0 (#4476, #4479).

# read an issue's milestone (none ⇒ the well-formed default, never a defect to repair)
kp_milestone_read() {   # $1 = issue number
gh api repos/$REPO/issues/"$1" --jq '.milestone.number // "none"'
}
# the existing open milestones — the ONLY legal assignment targets (never create one)
kp_milestone_catalog() {
gh api "repos/$REPO/milestones?state=open&per_page=100" --jq '.[] | "#\(.number)\t\(.title)"'
}
# assign to an existing open milestone (triage / plan-epic inherit) — numeric id, never the title
kp_milestone_assign() {   # $1 = issue number, $2 = milestone number
gh api -X PATCH repos/$REPO/issues/"$1" -f milestone="$2"
}
# clear a milestone (rare; assignment is the common write)
kp_milestone_clear() {   # $1 = issue number
gh api -X PATCH repos/$REPO/issues/"$1" -F milestone=null
}
# filter issues by milestone (write-code's drain-this-milestone query, a campaign sweep)
kp_milestone_issues() {   # $1 = milestone number
gh api "repos/$REPO/issues?state=open&milestone=$1&per_page=100"
}
