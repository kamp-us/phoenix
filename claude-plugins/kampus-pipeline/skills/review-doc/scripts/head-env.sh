#!/usr/bin/env bash
# Re-emit the head values `materialize-head.sh` resolved (PR_REF / HEAD_SHA, and REVIEW_WT if
# `--worktree` was used), so any later step recovers them after the harness resets the shell between
# Bash calls. Extracted from review-doc/SKILL.md's repeated re-source line (#4453, epic #4435 phase
# 1). Extraction contract: ../SKILL.md § The extracted scripts.
#
# usage: bash ./claude-plugins/kampus-pipeline/skills/review-doc/scripts/head-env.sh <pr>
#
# STDOUT IS THE ANSWER (ADR 0232, .patterns/skill-script-io-contract.md) — the same `KEY=value`
# lines materialize-head.sh printed, read back from this run's §SP handle. `scratchpad file` REFUSES
# when the namespace was never opened in this run, and an empty handle is refused too, so a lost
# handle exits non-zero with EMPTY stdout. Read the exit status BEFORE the stdout: no answer is
# UNKNOWN, never a licence to fall back to the launched checkout's working copy (§HEAD, #793).
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: head-env.sh <pr>" >&2; exit 2; }
PR="$1"
# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="$(kp_pcli)" || exit 127

HEAD_ENV="$("$PCLI" scratchpad file --slug "review-doc-$PR" --name head.env)" || exit 1
[ -s "$HEAD_ENV" ] || { echo "review-doc: §SP — head.env absent/empty; re-run the materialize step in THIS session." >&2; exit 1; }
cat "$HEAD_ENV"
