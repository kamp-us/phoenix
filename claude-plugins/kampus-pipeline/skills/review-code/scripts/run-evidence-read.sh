#!/usr/bin/env bash
# Step 2 — read the SHA-bound run-evidence bundle through the one tested verb (#3991, ADR 0054 §3).
# Extracted from review-code/SKILL.md (#4451, epic #4435 phase 1). Extraction contract:
# ../SKILL.md § The extracted scripts.
#
# STDOUT IS A MACHINE CHANNEL: the ONLY thing this writes to stdout is the run-state handle carrying
# BUNDLE / BUNDLE_STATE / BUNDLE_LINE, so the caller can `. "$(run-evidence-read.sh "$PR")"`. Four
# states come back on BUNDLE_STATE and they are DIFFERENT FACTS — `present` | `pending` | `absent` |
# `unknown`; read the state word, never the exit alone, and never report `pending`/`unknown` as
# `absent` (that invents a CI gap — PR #3913). An UNRESOLVED shim exits 127 with EMPTY stdout, so the
# caller's `.` fails loudly: "could not run" is not a bundle state.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: run-evidence-read.sh <pr>" >&2; exit 2; }
PR="$1"
REPO="$(kp_repo)" || exit 1
PCLI="$(kp_pcli)" || exit 127

HEAD_SHA="$(gh api repos/"$REPO"/pulls/"$PR" --jq '.head.sha')"
# Exit 0 means `present` — a validated, head-bound bundle. Every other state comes back on stdout
# as JSON, so read the state rather than branching on the exit alone.
BUNDLE="$("$PCLI" run-evidence read --pr "$PR")" || true
BUNDLE_STATE="$(jq -r '.state' <<<"$BUNDLE")"     # present | pending | absent | unknown
BUNDLE_LINE="$(jq -r '.reportLine' <<<"$BUNDLE")" # the verdict line, evidence already in it

OUT="$(kp_scratch_open review-code-bundle)/bundle.env" || exit 1
{
  printf 'HEAD_SHA=%s\n' "$HEAD_SHA"
  printf 'BUNDLE_STATE=%s\n' "$BUNDLE_STATE"
  printf 'BUNDLE_LINE=%s\n' "$(printf '%q' "$BUNDLE_LINE")"
} > "$OUT"
printf '%s\n' "$BUNDLE" > "$(dirname "$OUT")/bundle.json"
printf 'BUNDLE_JSON=%s\n' "$(dirname "$OUT")/bundle.json" >> "$OUT"
printf '%s\n' "$OUT"
