#!/usr/bin/env bash
# Step 2 degrade path — the FULL unit project, never a path-narrowed subset. Extracted from
# review-code/SKILL.md (#4451, epic #4435 phase 1). Extraction contract:
# ../SKILL.md § The extracted scripts. The why — that a feature-scoped green while a cross-cutting
# contract test is red is the #1657-class false green (ADR 0092) — stays in that step's prose.
#
# `test:unit` lives in `apps/web/package.json`, NOT the repo root, so the `-C` target is
# `$REVIEW_WT/apps/web`; a bare `pnpm -C "$REVIEW_WT" test:unit` hits ERR_PNPM_NO_SCRIPT.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

# re-source $REVIEW_WT/$PR_REF after a between-call reset (#1807)
# shellcheck disable=SC1007,SC1090
. "$("$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/head-env.sh")" || exit 1
: "${REVIEW_WT:?full-unit-project.sh: REVIEW_WT unset — the head was never materialized; refusing to test the base tree (§HEAD)}"

pnpm -C "$REVIEW_WT/apps/web" test:unit   # FULL unit project (the apps/web script) — never path-narrowed on the degrade path
