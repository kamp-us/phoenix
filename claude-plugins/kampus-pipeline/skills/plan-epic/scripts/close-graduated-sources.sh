#!/usr/bin/env bash
# Step 6: close every graduated source investigation the epic's brief names, idempotently. The
# *why* — that graduation had no close-on-source forcing function and plan-epic is the deterministic
# step that always touches a graduated epic — stays in ../SKILL.md § Step 6.
#
# usage: close-graduated-sources.sh <EPIC>
#
# A brief with no `resolved investigation #N` marker is a clean no-op. The per-source guard closes
# ONLY an open `type:investigation`, so a referenced epic/decision/bug and an already-closed source
# are both skipped — a re-plan run is a no-op.
#
# Extracted from plan-epic/SKILL.md (#4452, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: close-graduated-sources.sh <EPIC>" >&2; exit 2; }
EPIC="$1"
REPO="$(kp_repo)" || exit 1
PCLI="$(kp_pcli)" || exit 127
RUN_SCRATCH="$(kp_scratch_path "plan-epic-$EPIC")" || exit 1   # §SP re-derive (see scratch-open.sh)
[ -s "$RUN_SCRATCH/current.md" ] || { echo "plan-epic: §SP — Step 1's current.md did not survive; re-run Step 1 in THIS session." >&2; exit 1; }
# Extract every source the brief graduated from — tolerant of phrasing ("Emitted from resolved
# investigation #N", "from resolved investigation #N"). The `resolved investigation` anchor is what
# distinguishes a graduation provenance from an incidental `#N` cross-reference in the brief.
SOURCES=$(grep -oiE 'resolved investigation #[0-9]+' "$RUN_SCRATCH/current.md" \
  | grep -oE '[0-9]+' | sort -u)
for SRC in $SOURCES; do
  # Guard, fail-safe: close ONLY an open type:investigation — never a referenced epic/decision/bug,
  # and never re-close a closed source (idempotent, so a re-plan run is a clean no-op). This is what
  # keeps legitimately-open downstream artifacts (the epic itself, sibling epics) untouched.
  read -r STATE TYPES < <(gh api "repos/$REPO/issues/$SRC" \
    --jq '[.state, ([.labels[].name] | map(select(startswith("type:"))) | join(","))] | @tsv')
  case "$STATE:$TYPES" in
    open:*type:investigation*) ;;
    *) echo "plan-epic: source #$SRC is $STATE ($TYPES) — not an open investigation, skipping close."; continue ;;
  esac
  # Audit trail (AC): the `tracker graduate` verb owns the graduation-close envelope (ADR 0190,
  # #3266) — it posts the source → artifact provenance record so a reader can trace the graduation,
  # then closes the source as completed (the work graduated, it wasn't abandoned — distinct from
  # triage's not_planned). Don't hand-roll the comment + `state_reason=completed` PATCH; that inline
  # re-derivation is what the adoption lint (#3254) flags.
  "$PCLI" tracker graduate "$SRC" \
    --artifact "epic #$EPIC (planned by plan-epic)" \
    --note "closing this investigation as the durable \`graduated into #$EPIC\` record. Its diagnosis is carried forward by the epic and its planned children." >/dev/null
  echo "plan-epic: closed graduated source investigation #$SRC → epic #$EPIC."
done
