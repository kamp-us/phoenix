#!/usr/bin/env bash
# Step 1 — the class-aware no-linked-issue decision (ADR 0184/0075). Prints exactly ONE of two
# lines: the carve-out line (legitimate, `ISSUE` stays unset) or the hard-stop line. Extracted from
# review-code/SKILL.md (#4451, epic #4435 phase 1). Extraction contract + shell-option rationale:
# ../SKILL.md § The extracted scripts.
#
# The carve-out line is the PERMISSIVE answer, so every path that returns before the classification
# runs prints the HARD-STOP line first: a classifier that could not run is UNKNOWN, and UNKNOWN is
# never "legitimately issueless" (§ZS / ADR 0092; #4231, #4010, #4219). The `FILES=` read below needs
# no separate sentinel — gh writes its error document to STDOUT, which matches no `^\.glossary/` path,
# so a failed read already falls into the hard-stop branch.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

HARD_STOP="no linked issue on a PR carrying behavioral code — broken seam: hard-stop (dangling-code guard, ADR 0184)"

[ "$#" -ge 1 ] || {
	echo "$HARD_STOP"
	echo "usage: classify-issueless.sh <pr>" >&2
	exit 2
}
PR="$1"
# Top-level assignment, never `local` — `local REPO="$(kp_repo)"` masks the substitution's status.
REPO="$(kp_repo)" || { echo "$HARD_STOP"; exit 1; }

# no linked issue → class-aware. The carve-out is scoped EXACTLY to the conversation-authored
# coining class: the diff touches the `.glossary/**` CODE-class vocabulary coining site (ADR 0128)
# AND every changed path lies on a conversation-authored surface — `.glossary/**`, or a doc
# companion (`.decisions/**` / `.patterns/**`) carried in the same recording — and NOTHING else.
# Any path off those surfaces (`apps/**`, `packages/**`, `infra/**`, a code-root README, a root
# script) is behavioral work with a missing `Fixes #N` ⇒ a broken seam ⇒ hard-stop. Same file set +
# same path-prefix class Step 2's skills-only route uses — no second class mechanism.
# "every path is conversation-authored" is the EMPTY-OUTPUT form, never `! grep -qv` (§WL, #4155).
FILES="$(gh api --paginate "repos/$REPO/pulls/$PR/files?per_page=100" --jq '.[].filename')"
OFFSURFACE="$(grep -vE '^(\.glossary|\.decisions|\.patterns)/' <<<"$FILES")"
if [ -n "$FILES" ] \
   && grep -qE '^\.glossary/' <<<"$FILES" \
   && [ -z "$OFFSURFACE" ]; then
  echo "conversation-authored .glossary/** coining site, no Fixes #N — legitimate (ADR 0184/0075): ISSUE stays unset, AC half N/A"
else
  echo "no linked issue on a PR carrying behavioral code — broken seam: hard-stop (dangling-code guard, ADR 0184)"
fi
