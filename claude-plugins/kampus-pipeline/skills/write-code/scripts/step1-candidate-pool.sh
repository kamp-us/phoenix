#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2016
# Step 1's candidate pool: list unassigned `status:triaged` issues, priority bucket by bucket.
#
# Extracted VERBATIM from write-code/SKILL.md's Step 1 fenced block (epic #4435 phase 1, #4449).
# A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2 (#1929).
#
# SOURCED, never executed. The fenced block it replaces ran inline in the agent's shell, so this
# file deliberately sets NO shell options — the moved glue steers its own control flow and several
# blocks depend on `pipefail` being OFF — and it leaves its variables and functions in the sourcing
# shell, which is how the steps after it still see them. No EXIT trap: under bash 3.2 a cleanup
# trap's last command becomes the script's status, laundering a `set -u` abort into exit 0 (#4476,
# class #4479).
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

# p0 first; only fall through to p1, then p2 if a bucket is empty of unassigned issues
for P in p0 p1 p2; do
  gh api "repos/$REPO/issues?state=open&labels=status:triaged,$P&sort=created&direction=asc&per_page=100" \
    --jq '.[] | select(.assignee == null and (.pull_request | not)) | "#\(.number)\t\(.created_at)\t\(.title)"'
done
