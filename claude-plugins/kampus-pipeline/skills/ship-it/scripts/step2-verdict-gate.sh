#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2034,SC2086
# Derive this diff's required gate namespaces and run `verdict gate` — the enqueue precondition (guard 1).
#
# Extracted VERBATIM from ship-it/SKILL.md's Step 2 gate fenced block (epic #4435 phase 1, #4448).
# A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2 (#1929).
#
# SOURCED, never executed. The fenced block it replaces ran inline in the agent's shell, so this
# file deliberately sets NO shell options — several guards here depend on `pipefail` being OFF —
# and leaves its variables and functions in the sourcing shell, which is how the step's later
# blocks still see them.
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/bin/pipeline-cli"
# the required namespaces for THIS diff — one per artifact class present, plus review-design when
# the diff is UI-affecting. `.glossary/**` rides has-code, so an ADR + a glossary row requires BOTH
# review-doc AND review-code; satisfying one is not enough.
# The probe is the LAST stage of its own capture, and its status is read — `class-probe` REFUSES with
# exit 4 on a failed stdin read (#4010) and prints nothing, so an unchecked capture turns the refusal
# into an empty `--require` set. Joining with `| paste -sd, -` INSIDE the capture is what made that
# unobservable: `pipefail` is OFF here (#4146), so paste's 0 was the pipeline's status (#4231). Join
# the ALREADY-CAPTURED value instead. The `verdict gate` zero-scope refusal downstream is untouched —
# this removes the masking in front of it, it does not relocate the backstop.
REQUIRED_NS="$(gh api --paginate "repos/$REPO/pulls/$PR/files" --jq '.[].filename' \
  | "$PCLI" class-probe classify --namespaces)"; PROBE_RC=$?
if [ "$PROBE_RC" -ne 0 ]; then
  disarm_intent refuse || INTENT_UNCLEARED=1
  echo "ship-it: refused at guard 1 — class-probe REFUSED (exit $PROBE_RC); the required-namespace set is UNKNOWN, not empty. NOT enqueued." >&2; exit 1
fi
REQUIRED="$(printf '%s\n' "$REQUIRED_NS" | grep '[^[:space:]]' | paste -sd, - || true)"
if [ -z "$REQUIRED" ]; then
  disarm_intent refuse || INTENT_UNCLEARED=1
  echo "ship-it: refused at guard 1 (zero scope) — class-probe exited 0 but named ZERO namespaces; a zero-length required set would make the per-namespace conjunction vacuously true (ADR 0092). NOT enqueued." >&2; exit 1
fi
echo "ship-it guard 1: PR $PR requires $(printf '%s\n' "$REQUIRED_NS" | grep -c '[^[:space:]]' || true) namespace(s) → $REQUIRED"
# A control-plane PR's pass path is the canonical SHA-less ADVISORY, bound in the body's
# `Reviewed-head` line (ADR 0111/0151) — pass --cp so that form counts, and ONLY then. Set this from
# Step 0's own classification (it printed `BLOCKING (…)` for a §CP path/content hit) AND only after
# Step 0's approval gate discharged; leave it empty for every non-§CP PR.
CP_FLAG=""   # → "--cp" iff Step 0 classified this PR §CP and its control-plane approval discharged
"$PCLI" verdict gate --pr "$PR" --require "$REQUIRED" $CP_FLAG || {
  disarm_intent refuse || INTENT_UNCLEARED=1
  echo "ship-it: refused at guard 1 — see the named reason above; NOT enqueued."; exit 1; }
