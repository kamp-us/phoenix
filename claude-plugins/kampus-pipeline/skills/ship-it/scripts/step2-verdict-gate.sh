#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2034,SC2086
# Derive this diff's required gate namespaces and run `verdict gate` — the enqueue precondition (guard 1).
#
# Extracted VERBATIM from ship-it/SKILL.md's Step 2 gate fenced block (epic #4435 phase 1, #4448).
# A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2 (#1929).
#
# DUAL-MODE (ADR 0232) — the why is `.patterns/skill-script-shell-shape.md` § The dual-mode shape.
#   EXECUTED:  bash ./claude-plugins/kampus-pipeline/skills/ship-it/scripts/step2-verdict-gate.sh \
#                   <REPO> <PR> [--cp]
#              stdout ⇒ one `ship-it guard 1: …` line naming the required namespaces. The EXIT STATUS
#              is the gate: 0 only when `verdict gate` passed every required namespace. Every refusal
#              names itself on stderr and exits 1 — read the status first, never the stdout's shape.
#   SOURCED:   `verify-chain-resolves.sh` check 3 sources this file to prove the §CP seam reaches
#              `verdict gate`, reading $REPO / $PR / $CP_FLAG out of its own driver shell. Untouched.
#
# THIS FILE IS THE `pipefail`-OFF EXEMPLAR `.patterns/skill-script-shell-shape.md` names, so the
# option is not simply switched on: the ONE guard that read a pipeline's status — `PROBE_RC` below —
# is re-derived as capture-then-match so it still answers with `class-probe`'s own status and nothing
# else. See its comment. Every other pipeline here either cannot fail in its producer stage
# (`printf`) or has its status discarded, so `pipefail` is inert over them.
# No EXIT trap — under bash 3.2 a cleanup trap's last command becomes the script's status,
# laundering a `set -u` abort into exit 0 (#4476, class #4479).

if [ "${BASH_SOURCE[0]}" = "$0" ]; then set -uo pipefail; fi   # executed mode only (ADR 0232)
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"
# `disarm_intent` (guard 6 / ADR 0198), sourced IN-CHAIN — a process inherits no functions, so the
# SKILL.md preamble can no longer leave it in the shell for this step (ADR 0232).
# shellcheck source=disarm-intent.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/." && pwd)/disarm-intent.sh"

# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/bin/pipeline-cli"
REPO="${REPO:-${1:?step2-verdict-gate.sh: REPO unset and no \$1 — refusing to gate a PR in an unnamed repo}}"
PR="${PR:-${2:?step2-verdict-gate.sh: PR unset and no \$2 — refusing to gate an unnamed PR}}"
# the required namespaces for THIS diff — one per artifact class present, plus review-design when
# the diff is UI-affecting. `.glossary/**` rides has-code, so an ADR + a glossary row requires BOTH
# review-doc AND review-code; satisfying one is not enough.
# The probe is the LAST stage of its own capture, and its status is read — `class-probe` REFUSES with
# exit 4 on a failed stdin read (#4010) and prints nothing, so an unchecked capture turns the refusal
# into an empty `--require` set. Joining with `| paste -sd, -` INSIDE the capture is what made that
# unobservable: `pipefail` is OFF here (#4146), so paste's 0 was the pipeline's status (#4231). Join
# the ALREADY-CAPTURED value instead. The `verdict gate` zero-scope refusal downstream is untouched —
# this removes the masking in front of it, it does not relocate the backstop.
# CAPTURE-THEN-MATCH, and the capture is what preserves the guard under executed mode's `pipefail`.
# `PROBE_RC` must be `class-probe`'s OWN status — that is what discriminates its exit-4 refusal from
# a classification. Left as one pipeline, `pipefail` would fold `gh`'s status into it too, so a
# transport failure would report itself as a class-probe refusal. Splitting the stages restores the
# original operand exactly: `printf` cannot fail, so the pipeline's status IS the probe's. `gh`'s own
# status is deliberately left unread HERE, exactly as the pipe left it unread — its stdout (an error
# document included) reaches the probe byte-for-byte as before, and the probe's #4010 fail-closed
# stdin read is what judges it. This is a relay of the same decision, not a new guard (ADR 0228).
PROBE_IN="$(gh api --paginate "repos/$REPO/pulls/$PR/files" --jq '.[].filename')"
REQUIRED_NS="$(printf '%s\n' "$PROBE_IN" | "$PCLI" class-probe classify --namespaces)"; PROBE_RC=$?
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
#
# THE SEAM (#4547). $CP_FLAG arrives from the CALLER's shell — Step 0 sets `CP_FLAG=--cp` on the §CP
# discharge branch and nothing sets it otherwise. A caller-set variable rather than a positional,
# because this value is DERIVED by an earlier step of the same sourced chain (like $PR and $REPO,
# which already reach here that way), whereas step0-preflight.sh's `$1` is the run's ENTRY value that
# no earlier step could have set. A positional here would put the §CP/non-§CP choice back at the
# source site as something the shipper types by hand — the hand-substitution this seam removes.
# Unset ⇒ empty ⇒ the non-§CP branch, which is the STRICTER one (the SHA-less advisory does not
# count), so an omitted seam can only refuse a §CP PR, never pass one.
# Under ADR 0232 the seam arrives as the THIRD ARGUMENT, printed by `step0-cp-approval.sh`'s
# discharge branch and re-passed by the shipper; a sourced caller's own $CP_FLAG still wins, so
# `verify-chain-resolves.sh` check 3 exercises the same seam it always did. Absent ⇒ empty ⇒ the
# non-§CP branch, which is the STRICTER one.
CP_FLAG="${CP_FLAG:-${3-}}"
case "$CP_FLAG" in
  ""|"--cp") ;;
  # A third value is not a classification. It would reach `verdict gate` as an unrecognized flag —
  # help text plus a non-zero exit, refused below with the wrong reason named. Refuse here instead,
  # naming the real one (§ZS: an uninterpretable input is UNKNOWN, never the permissive branch).
  *) disarm_intent refuse || INTENT_UNCLEARED=1
     echo "ship-it: refused at guard 1 — CP_FLAG is '$CP_FLAG'; the only values this seam accepts are '' (non-§CP) and '--cp'. An unrecognized value is UNKNOWN, not a classification. NOT enqueued." >&2; exit 1 ;;
esac
"$PCLI" verdict gate --pr "$PR" --require "$REQUIRED" $CP_FLAG || {
  disarm_intent refuse || INTENT_UNCLEARED=1
  echo "ship-it: refused at guard 1 — see the named reason above; NOT enqueued."; exit 1; }
