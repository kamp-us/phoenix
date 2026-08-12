#!/usr/bin/env bash
# Step 2 — install + lint inside the review worktree (behavior verified by running beats behavior
# inferred from a diff). Extracted from review-code/SKILL.md (#4451, epic #4435 phase 1). Extraction
# contract + shell-option rationale: ../SKILL.md § The extracted scripts.
#
# usage: bash ./claude-plugins/kampus-pipeline/skills/review-code/scripts/worktree-checks.sh <pr>
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: worktree-checks.sh <pr>" >&2; exit 2; }
PR="$1"
# re-source the run-unique $REVIEW_WT/$PR_REF after a between-call reset (#1807) — never re-derive
# from the shared `review-head-${PR}` leaf name
# shellcheck disable=SC1007
HERE="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
HANDLE="$(bash "$HERE/head-env.sh" "$PR")" || exit 1
# shellcheck disable=SC1090
. "$HANDLE" || exit 1
: "${REVIEW_WT:?worktree-checks.sh: REVIEW_WT unset — the head was never materialized; refusing to check the base tree (§HEAD)}"
kp_head_handle_names_pr "$PR" "$HANDLE" || exit 1   # never install+lint a SIBLING reviewer's tree (#5416)

pnpm -C "$REVIEW_WT" install   # the catalog/lockfile + patches/ are present, so this succeeds
# Lint via `pnpm lint:worktree`, never `pnpm lint` / `biome check .`: bare `.` resolves to the
# review worktree's CWD (sits under .claude/worktrees → matches `!**/.claude/worktrees`) and exits
# 0 WITHOUT linting (false green; #236, ADR 0060). `lint:worktree` lints the EXPLICIT changed files
# vs origin/main (committed + working-tree, biome-extension-filtered; docs-only/empty = clean skip),
# so it catches root + `.claude/**` violations a bare `biome check apps packages` would miss and
# reliably predicts the CI lint job (#553/#559):
pnpm -C "$REVIEW_WT" lint:worktree   # and/or the specific test the criterion names
