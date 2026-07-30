#!/usr/bin/env bash
# Print one merged PR's title, its `area:*` label (the join-free product/infra signal, #1598), and
# its body — the body is where the `Fixes #N` / `Closes #N` linked issue lives.
#
# usage: pr-context.sh <pr>
#
# Extracted from what-shipped/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: pr-context.sh <pr>" >&2; exit 2; }
REPO="$(kp_repo)" || exit 1

gh api "repos/$REPO/pulls/$1" --jq '{title: .title, body: .body, labels: [.labels[].name]}'
