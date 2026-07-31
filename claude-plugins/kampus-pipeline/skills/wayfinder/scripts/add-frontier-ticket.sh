#!/usr/bin/env bash
# File one frontier ticket and link it to the map as a NATIVE sub-issue. Prints the new child's issue
# number on stdout.
#
# usage: add-frontier-ticket.sh <map-issue> "<title>" <type:investigation|type:decision> < body.md
#
# The `sub_issues` endpoint takes the child's internal DATABASE id (`.id`), not its issue number —
# which is why the create call reads back both.
#
# The body arrives on STDIN and an EMPTY stdin is REFUSED, for the same reason `create-map.sh` refuses
# one: the fence carried the body as a literal, the pipe makes it an external input, and an unread pipe
# is byte-identical to an empty one (#3924 / #4010).
#
# Extracted from wayfinder/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 3 ] || { echo "wayfinder: add-frontier-ticket.sh needs <map-issue> <title> <type-label> — NO ticket was filed."; echo "usage: add-frontier-ticket.sh <map-issue> \"<title>\" <type:investigation|type:decision> < body.md" >&2; exit 2; }
MAP="$1"
TITLE="$2"
TYPE="$3"
case "$TYPE" in
	type:investigation | type:decision) ;;
	*)
		echo "wayfinder: '$TYPE' is not a frontier type — the translation table admits only type:investigation and type:decision. NO ticket was filed."
		exit 2
		;;
esac
REPO="$(kp_repo)" || { echo "wayfinder: target repo unresolved — NO ticket was filed."; exit 1; }

BODY="$(cat)"
[ -n "$BODY" ] || { echo "wayfinder: stdin was empty — refusing to file a BODYLESS frontier ticket. NOTHING was filed."; exit 3; }

CHILD_JSON=$(gh api -X POST "repos/$REPO/issues" \
	-f title="$TITLE" \
	-f "labels[]=$TYPE" \
	-f body="$BODY" --jq '{id, number}')
CHILD_ID=$(jq -r '.id // empty' <<<"$CHILD_JSON")
CHILD_NUMBER=$(jq -r '.number // empty' <<<"$CHILD_JSON")
[ -n "$CHILD_ID" ] && [ -n "$CHILD_NUMBER" ] || { echo "wayfinder: the create call returned no id/number — the ticket may or may not exist, and it is NOT linked to map #$MAP."; exit 1; }

gh api -X POST "repos/$REPO/issues/$MAP/sub_issues" -F sub_issue_id="$CHILD_ID" >/dev/null ||
	{ echo "wayfinder: filed #$CHILD_NUMBER but the sub-issue LINK to map #$MAP did NOT land — link it before charting on."; exit 1; }

printf '%s\n' "$CHILD_NUMBER"
