#!/usr/bin/env bash
# The live branch re-derivation every git op after the Step-4 branch cut runs on.
#
# usage: step4-live-branch.sh <worktree-root>     (the root `step4-wt-preflight.sh` just resolved)
#
# stdout IS the branch checked out in <worktree-root> — the source of truth, re-read at each git op.
# An absent root, a root that is not a worktree, or a HEAD that names no branch (detached) refuses
# with NOTHING on stdout and a non-zero exit: the caller must never push to a guessed or cached ref,
# so silence here is a refusal, never "no branch" (§ZS / ADR 0092).
#
# Executed, never sourced (ADR 0232). This is the enforcement site of the never-carry-the-branch rule
# — the name is created once at the branch cut and re-derived live from the worktree at every later
# git op, never persisted to a scratchpad file a concurrent lane can clobber (#2038).
# shellcheck disable=SC1007,SC2016
set -uo pipefail

WT="${1:-}"
if [ -z "$WT" ]; then
	printf 'write-code: no worktree root — run this as `bash ./claude-plugins/kampus-pipeline/skills/write-code/scripts/step4-live-branch.sh "$WT"`, passing the root `step4-wt-preflight.sh` resolved. NO branch was derived; refusing to push to a guessed/cached ref.\n' >&2
	exit 1
fi
BRANCH="$(git -C "$WT" branch --show-current)"
: "${BRANCH:?could not re-derive branch from worktree $WT — refusing to push to a guessed/cached ref}"
printf '%s\n' "$BRANCH"
