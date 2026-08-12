#!/usr/bin/env bash
# Step 2 degrade path — the FULL unit project, never a path-narrowed subset. Extracted from
# review-code/SKILL.md (#4451, epic #4435 phase 1). Extraction contract:
# ../SKILL.md § The extracted scripts. The why — that a feature-scoped green while a cross-cutting
# contract test is red is the #1657-class false green (ADR 0092) — stays in that step's prose.
#
# `test:unit` lives in `apps/web/package.json`, NOT the repo root, so the `-C` target is
# `$REVIEW_WT/apps/web`; a bare `pnpm -C "$REVIEW_WT" test:unit` hits ERR_PNPM_NO_SCRIPT.
#
# usage: bash ./claude-plugins/kampus-pipeline/skills/review-code/scripts/full-unit-project.sh <pr>
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: full-unit-project.sh <pr>" >&2; exit 2; }
PR="$1"
# re-source $REVIEW_WT/$PR_REF after a between-call reset (#1807)
# shellcheck disable=SC1007
HERE="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
HANDLE="$(bash "$HERE/head-env.sh" "$PR")" || exit 1
# shellcheck disable=SC1090
. "$HANDLE" || exit 1
: "${REVIEW_WT:?full-unit-project.sh: REVIEW_WT unset — the head was never materialized; refusing to test the base tree (§HEAD)}"
kp_head_handle_names_pr "$PR" "$HANDLE" || exit 1   # never run a SIBLING reviewer's unit project (#5416)

pnpm -C "$REVIEW_WT/apps/web" test:unit   # FULL unit project (the apps/web script) — never path-narrowed on the degrade path
