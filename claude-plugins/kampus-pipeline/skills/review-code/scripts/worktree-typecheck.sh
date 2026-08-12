#!/usr/bin/env bash
# Step 2 — the authoritative in-worktree typecheck (ADR 0067, reversing 0060's deferred-to-CI
# workaround). Extracted from review-code/SKILL.md (#4451, epic #4435 phase 1). Extraction contract:
# ../SKILL.md § The extracted scripts.
#
# usage: bash ./claude-plugins/kampus-pipeline/skills/review-code/scripts/worktree-typecheck.sh <pr>
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: worktree-typecheck.sh <pr>" >&2; exit 2; }
PR="$1"
# shellcheck disable=SC1007
HERE="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
HANDLE="$(bash "$HERE/head-env.sh" "$PR")" || exit 1
# shellcheck disable=SC1090
. "$HANDLE" || exit 1
: "${REVIEW_WT:?worktree-typecheck.sh: REVIEW_WT unset — the head was never materialized; refusing to typecheck the base tree (§HEAD)}"
# The handle is only mine if it describes MY PR: a typecheck of a sibling's tree passes, and the
# verdict it feeds is bound to this PR's own live head SHA, so the green is wrong and unfalsifiable
# from the outside (#5416).
kp_head_handle_names_pr "$PR" "$HANDLE" || exit 1

pnpm -C "$REVIEW_WT" typecheck   # `pnpm install` above made patches/ hashable + `fate generate` resolvable
