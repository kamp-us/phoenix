#!/usr/bin/env bash
# Step 2 — the authoritative in-worktree typecheck (ADR 0067, reversing 0060's deferred-to-CI
# workaround). Extracted from review-code/SKILL.md (#4451, epic #4435 phase 1). Extraction contract:
# ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

# shellcheck disable=SC1007,SC1090
. "$("$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/head-env.sh")" || exit 1
: "${REVIEW_WT:?worktree-typecheck.sh: REVIEW_WT unset — the head was never materialized; refusing to typecheck the base tree (§HEAD)}"

pnpm -C "$REVIEW_WT" typecheck   # `pnpm install` above made patches/ hashable + `fate generate` resolvable
