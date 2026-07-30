#!/usr/bin/env bash
# The mandatory pre-filing dedup query (ADR 0181): print one `#<n>\t<title>` line per candidate
# duplicate, and the candidate count on stderr. The verb resolves the target repo itself, so it
# needs no $REPO.
#
# usage: dedup-check.sh <the title + a few distinguishing keywords>
#
# stdout is the verb's own output RELAYED unchanged (ADR 0228). An empty stdout means "no likely
# match" ONLY on exit 0; a non-zero exit means the check never ran, which is UNKNOWN — file rather
# than treat it as clean (a duplicate is cheap for triage to close, a lost observation is gone).
#
# Extracted from report/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: dedup-check.sh <title + keywords>" >&2; exit 2; }
PCLI="$(kp_pcli)" || exit 127

"$PCLI" intake-dedup check \
  --query "$1"
