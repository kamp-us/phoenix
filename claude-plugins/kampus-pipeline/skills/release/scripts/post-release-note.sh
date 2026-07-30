#!/usr/bin/env bash
# Step 5: post the human-readable release note on the linked issue (#1354).
#
# usage: post-release-note.sh <linked-issue> <flag-key> <env> <serving-now> <releaser>
#
# <serving-now> is the EXACT effective-serving string Step 3 confirmed (`on@100% (split)` or
# `on@N% (ramping)`), so the note records the true post-flip state, not an assumed one. It is a
# required argument for that reason — there is no default that could quietly record a state nobody
# read back.
#
# Extracted from release/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

[ "$#" -ge 5 ] || { echo "usage: post-release-note.sh <linked-issue> <flag-key> <env> <serving-now> <releaser>" >&2; exit 2; }
LINKED_ISSUE="$1"; FLAG_KEY="$2"; ENV="$3"; SERVING_NOW="$4"; RELEASER="$5"
REPO="$(kp_repo)" || exit 1

NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
BODY="$(cat <<EOF
## Released 🚀 — \`$FLAG_KEY\`

- **Flag:** \`$FLAG_KEY\` (env: \`$ENV\`)
- **Serving:** dark (\`off (default)\`) → live (\`$SERVING_NOW\`)
- **Released:** $NOW by $RELEASER
- **Closes the release queue for:** #$LINKED_ISSUE

The feature is now visible to users. The dark deploy (agent-merged) is now a release (human flip)
— the ADR 0083 boundary, closed.
EOF
)"
gh api "repos/$REPO/issues/$LINKED_ISSUE/comments" -f body="$BODY"
