#!/usr/bin/env bash
# Report where each anka-ops credential resolves from and whether it authenticates — the Step-0
# credential pre-flight.
#
# usage: auth-status.sh
#
# Relays anka-ops' own output and exit status; it derives no release decision (ADR 0228). A non-zero
# exit means the pre-flight never landed — UNKNOWN, never "credentials fine". The prose reads the ABSENCE
# of a "does not authenticate" line as permission to proceed, so each locate/cd failure prints its own
# refusal on stdout rather than exiting silent (§ZS / ADR 0092; the #4485 class).
#
# Extracted from release/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=./lib.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

ANKA="$(release_anka_ops_dir)" || { echo "release: the flag lever is unlocatable — credentials NOT checked (UNKNOWN, never 'fine'). Do not touch a flag."; exit 1; }
cd "$ANKA" || { echo "release: could not enter the flag lever's package — credentials NOT checked (UNKNOWN, never 'fine'). Do not touch a flag."; exit 1; }
node src/bin.ts auth status
