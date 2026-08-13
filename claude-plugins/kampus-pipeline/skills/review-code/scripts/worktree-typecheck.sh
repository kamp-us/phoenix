#!/usr/bin/env bash
# Step 2 — the authoritative in-worktree typecheck (ADR 0067, reversing 0060's deferred-to-CI
# workaround). Extracted from review-code/SKILL.md (#4451, epic #4435 phase 1). Extraction contract:
# ../SKILL.md § The extracted scripts.
#
# It delegates to `attested-turbo-run.sh` rather than calling `pnpm typecheck` itself, because a bare
# invocation can exit 0 off another worktree's cached result — that script's header has the why
# (#4887). stdout is its one-line attestation; cite it as the typecheck evidence.
#
# usage: bash ./claude-plugins/kampus-pipeline/skills/review-code/scripts/worktree-typecheck.sh <pr>
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: worktree-typecheck.sh <pr>" >&2; exit 2; }
# shellcheck disable=SC1007
HERE="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$HERE/attested-turbo-run.sh" "$1" typecheck
