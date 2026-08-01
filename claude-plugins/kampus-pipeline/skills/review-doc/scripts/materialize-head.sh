#!/usr/bin/env bash
# Step 2 — §HEAD materialization: land the PR head in a per-run ref (default) or additionally in a
# throwaway detached worktree (`--worktree`), and record the handles in this run's §SP namespace.
# Extracted from review-doc/SKILL.md (#4453, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
#
# usage: bash ./claude-plugins/kampus-pipeline/skills/review-doc/scripts/materialize-head.sh <pr> [--worktree]
#
# STDOUT IS THE ANSWER (ADR 0232, .patterns/skill-script-io-contract.md) — one `KEY=value` line per
# resolved value: PR_REF / HEAD_SHA, plus REVIEW_WT under `--worktree`. Diagnostics go to stderr. On
# ANY failure path stdout stays EMPTY and the exit is non-zero — read the exit status BEFORE the
# stdout, because a materialization that could not run is UNKNOWN and must never fall back to the
# launched checkout's BASE tree (#793, the false-PASS hazard).
#
# The same values also persist to this run's §SP handle, which this skill's OWN later scripts
# re-source in-process via head-env.sh. In-script sourcing stays sanctioned under ADR 0232; only the
# `.` at an agent's top-level command is banned.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: materialize-head.sh <pr> [--worktree]" >&2; exit 2; }
PR="$1"; MODE="${2:-}"
# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="$(kp_pcli)" || exit 127

# §SP FIRST — allocate this run's scratch namespace, and land the head handles in a file inside it.
# $PR_REF / $HEAD_SHA (and $REVIEW_WT below) are needed by LATER Bash calls — Step 4a's ADR sweep
# reads `git show "$PR_REF:…"` — and a shell variable does not survive the harness's between-call
# reset. So they go in `head.env` under the per-run namespace, whose path is a deterministic
# function of this run's session id and is therefore RE-DERIVABLE in any later call. A `mktemp`
# path is not: by the next call the handle itself is a lost shell variable with no way back to it
# (#4041). §SP rules 2+3 apply here, NOT the rule-4 carve-out — that one is for a temp allocated
# AND consumed inside one call, like the ADR sweep's subject dir. `scratchpad` is the allocator (§SP
# rule 2 of ../gh-issue-intake-formats.md); it refuses with a reason on stderr rather than falling
# back to a shared path, and §SP's one-liner is the same namespace for a run with no CLI on PATH.
"$PCLI" scratchpad open --slug "review-doc-$PR" >/dev/null || exit 1   # ONCE, at the start of the run
HEAD_ENV="$("$PCLI" scratchpad file --slug "review-doc-$PR" --name head.env)" || exit 1

# Land the head in a per-run ref via the shared `pipeline-cli review-head materialize` verb
# (#3690 / #793 / #1807) — cite it, don't re-derive it. Ref-only mode (no `--worktree`): it
# resolves the live head SHA (REST), fetches `pull/<pr>/head` into a nonce-uniqued per-run ref
# WITHOUT touching the working tree, and asserts the fetched ref IS that head. It never runs
# `gh pr checkout` / `git checkout` / `git switch` (which would land the head in the shared PRIMARY
# the harness resets this cwd to and detach the human's `main` — #2270/#1103; §RO). It emits the
# head + ref as JSON.
if [ "$MODE" = "--worktree" ]; then
  "$PCLI" review-head materialize --pr "$PR" --worktree \
    | jq -r '"REVIEW_WT=\(.worktreeDir)\nPR_REF=\(.prRef)\nHEAD_SHA=\(.headSha)"' > "$HEAD_ENV"
else
  "$PCLI" review-head materialize --pr "$PR" \
    | jq -r '"PR_REF=\(.prRef)\nHEAD_SHA=\(.headSha)"' > "$HEAD_ENV"
fi
# shellcheck disable=SC1090  # the run-unique handle this script just wrote
. "$HEAD_ENV"
[ -n "${PR_REF:-}" ] && [ -n "${HEAD_SHA:-}" ] || {
  echo "FATAL: review-head materialize did not yield a head ref — aborting (never review the base tree; §HEAD)." >&2; exit 1; }
if [ "$MODE" = "--worktree" ] && [ -z "${REVIEW_WT:-}" ]; then
  echo "FATAL: --worktree was asked for but no worktree came back — aborting (§HEAD)." >&2; exit 1
fi

# THE ANSWER — the resolved values, one KEY=value line each, and the only stdout this script writes.
# Printed from the variables the handle read back above, so what the caller reads and what the later
# steps re-source through head-env.sh are the same values by construction.
[ -n "${REVIEW_WT:-}" ] && printf 'REVIEW_WT=%s\n' "$REVIEW_WT"
printf 'PR_REF=%s\nHEAD_SHA=%s\n' "$PR_REF" "$HEAD_SHA"
