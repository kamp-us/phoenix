#!/usr/bin/env bash
# Step 3's create-once split: file one single-unit child of #N, unless split-guard says a child
# already covers this (parent, title) unit (#3464).
#
# usage: split-child.sh <parent-N> <single-unit title> <body-file>
#
# The body arrives as a FILE, not an argument: it must carry the `split from #<N>` back-reference
# (the guard's create-once key) and is multi-line markdown, which an argv string mangles.
#
# Extracted from triage/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

[ "$#" -ge 3 ] || { echo "usage: split-child.sh <parent-N> <title> <body-file>" >&2; exit 2; }
N="$1"; TITLE="$2"; BODY_FILE="$3"
[ -s "$BODY_FILE" ] || { echo "split-child: body file '$BODY_FILE' is missing/empty — refusing to file a bodyless child." >&2; exit 2; }
PCLI="$(kp_pcli)" || exit 127

# 1. Create-once guard: skip the POST if a child already covers this (parent, title) unit (#3464).
EXISTING=$("$PCLI" split-guard check \
  --parent "$N" --title "$TITLE")
if [ -n "$EXISTING" ]; then
  echo "split-guard: $EXISTING already covers this unit — reusing, not creating a twin"
else
  # 2. Body MUST carry the `split from #<N>` back-reference — it is the guard's create-once key.
  #    The `tracker create-issue` verb owns this intake-create envelope (ADR 0190;
  #    `packages/pipeline-cli/src/tools/tracker/`), filing a status:needs-triage issue — don't
  #    hand-roll the `gh api repos/$REPO/issues` create (the adoption lint (#3254) flags it).
  BODY="$(cat "$BODY_FILE")"
  "$PCLI" tracker create-issue --title "$TITLE" --body "$BODY"
  # then cross-link via a comment on the original (Step 6 shows the comment call)
fi
