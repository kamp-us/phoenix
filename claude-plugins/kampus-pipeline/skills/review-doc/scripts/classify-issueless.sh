#!/usr/bin/env bash
# Step 1 — is the diff doc/vocab-surface-only, i.e. is a missing `Fixes #N` legitimate (ADR 0075 /
# 0184)? Extracted from review-doc/SKILL.md (#4453, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
#
# THE EXIT STATUS IS THE ANSWER: 0 = doc/vocab-surface-only (issueless is legitimate), non-zero = no
# (hard-stop). The predicate is single-sourced in §CLASS (DOC_VOCAB_EXCLUDE_RE /
# DOC_VOCAB_SURFACE_RE) and fails closed to "no" on an unreadable source or zero input (ADR 0092) —
# it can only ever REFUSE the allowance, never grant one it could not prove. This script keeps that
# direction: every guard below exits non-zero, so a could-not-run is a refusal, never a carve-out.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: classify-issueless.sh <pr>" >&2; exit 2; }
PR="$1"
REPO="$(kp_repo)" || exit 1
# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="$(kp_pcli)" || exit 127

gh api --paginate "repos/$REPO/pulls/$PR/files?per_page=100" --jq '.[].filename' \
  | "$PCLI" class-probe doc-vocab-surface-only
