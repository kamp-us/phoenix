#!/usr/bin/env bash
# Open a new `wayfinder:map` issue. Prints the new map's issue NUMBER on stdout.
#
# usage: create-map.sh "<destination, as a short noun phrase>" < body.md
#
# REST only — the org bans GraphQL for issue ops.
#
# The body arrives on STDIN, and an EMPTY stdin is REFUSED: the map body is authored prose, and moving
# it from a `$BODY` variable inside the fence to a pipe made it an external input. An unread pipe is
# byte-identical to an empty one, so filing on it would open a bodyless map that reads as a successful
# chart (#3924 / #4010). This guard is added because the extraction created the hazard.
#
# Extracted from wayfinder/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "wayfinder: create-map.sh needs a destination title — NO map was created."; echo "usage: create-map.sh \"<destination>\" < body.md" >&2; exit 2; }
TITLE="$1"
REPO="$(kp_repo)" || { echo "wayfinder: target repo unresolved — NO map was created."; exit 1; }

BODY="$(cat)"
[ -n "$BODY" ] || { echo "wayfinder: stdin was empty — refusing to open a BODYLESS map. NO map was created."; exit 3; }

MAP=$(gh api -X POST "repos/$REPO/issues" \
	-f title="$TITLE" \
	-f "labels[]=wayfinder:map" \
	-f body="$BODY" --jq '.number')
[ -n "$MAP" ] || { echo "wayfinder: the create call returned no issue number — the map may or may not exist; check before retrying."; exit 1; }

printf '%s\n' "$MAP"
