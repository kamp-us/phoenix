#!/usr/bin/env bash
# Rerun the failed jobs exactly ONCE and — on a PR run — write the durable marker the one-rerun guard
# reads back. Reach this only when the `already-rerun` flag is NOT set; the rule itself lives in the
# skill's prose (ADR 0228).
#
# usage: rerun-once.sh <run-id> <signature> [pr]
#
# The marker body below and `already-rerun.sh`'s `test("heal-ci:.*rerun queued")` grep are a PAIRED
# CONTRACT: change the phrasing here and you must update the matcher there. Extraction moved both
# halves out of prose, so the pair is now two files instead of two fences — the coupling is unchanged.
#
# The rerun is attempted BEFORE the marker on purpose, and a failed rerun does not write one: a marker
# with no rerun behind it would make a later invocation refuse to rerun a run that never was.
#
# Extracted from heal-ci/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 2 ] || { echo "heal-ci: rerun-once.sh needs a run id and a signature — nothing was rerun."; echo "usage: rerun-once.sh <run-id> <signature> [pr]" >&2; exit 2; }
RUN="$1"
SIGNATURE="$2"
PR="${3:-}"

gh run rerun "$RUN" --failed || { echo "heal-ci: rerun of run $RUN FAILED — no marker written, nothing was queued."; exit 1; }

if [ -n "$PR" ]; then
	REPO="$(kp_repo)" || { echo "heal-ci: run $RUN was rerun but the target repo is unresolved — the marker is MISSING; write it by hand before re-invoking."; exit 1; }
	# on a PR run, write the marker the already-rerun detector queries:
	gh api "repos/$REPO/issues/$PR/comments" \
		-f body="heal-ci: $SIGNATURE — rerun queued (run $RUN). One rerun only; a recurring failure becomes a defect." >/dev/null ||
		{ echo "heal-ci: run $RUN was rerun but the marker comment did NOT post — the cross-invocation guard now rests on \`attempt\` alone."; exit 1; }
fi

printf 'rerun queued (run %s): %s — will not retry again\n' "$RUN" "$SIGNATURE"
