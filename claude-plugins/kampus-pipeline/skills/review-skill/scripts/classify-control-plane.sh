#!/usr/bin/env bash
# Step 0 — blocking vs non-blocking, via the shared §CP entry point plus the ADR-0164 content probe.
# Extracted from review-skill/SKILL.md (#4453, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts. The *why* for each clause stays in
# that step's prose.
#
# STDOUT IS THE ANSWER, AND ITS EMPTY STATE IS THE PERMISSIVE ONE: a `BLOCKING (…)` line means hold
# the PR as §CP, and NO line means proven-ordinary. So every could-not-run path prints its own
# `BLOCKING (…)` line BEFORE exiting, and exits non-zero — a classifier that never ran must never
# reach the caller as silence, which the caller reads as "auto-mergeable" (§ZS / ADR 0092,
# `.patterns/skill-script-io-contract.md`; #4216, #4161, #4219). Read the STATUS before the STDOUT:
# a non-zero exit holds the PR as §CP whatever stdout says.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"
# §CPREAD's `cp_changed_files` + `cp_head_sha`, sourced from their canonical home — no skill-local
# copy to drift (#4489 extracted them out of ../../gh-issue-intake-formats.md, which is why the moved
# comment below no longer says "copy them verbatim"). They write on stderr only, so no call site
# redirects (`.patterns/skill-script-io-contract.md`, #4510).
# shellcheck source=../../shared/scripts/cp-read.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/scripts" && pwd)/cp-read.sh"

[ "$#" -ge 1 ] || {
  echo "BLOCKING (classify-control-plane.sh ran with no <pr> argument — nothing was classified ⇒ §CP, fail-closed)"
  echo "usage: classify-control-plane.sh <pr>" >&2; exit 2; }
PR="$1"
REPO="$(kp_repo)" || {
  echo "BLOCKING (target repo unresolvable — §CP unclassifiable ⇒ §CP, fail-closed)"; exit 1; }
# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="$(kp_pcli)" || {
  echo "BLOCKING (the CLI shim is UNRESOLVED — cp-classify never ran ⇒ §CP, fail-closed)"; exit 127; }

# The shared §CP classification entry point — one verb all the gates cite (#4161, formats §CP). It
# re-resolves CONTROL_PLANE_RE from origin/main itself (§CP travels in the INJECTED skill snapshot,
# which can lag origin/main even when the on-disk file is current — a pre-amendment snapshot once
# mis-flagged a now-control-plane PR as auto-mergeable, #981) AND covers the second §CP source: a
# guard-touching `.decisions/**` ADR is §CP BY CONTENT (ADR 0164) with zero path matches, so the old
# path-only grep here flagged it non-blocking — the fail-open this verb removes.
# Four states on stdout: control-plane / content-undetermined / not-control-plane / unknown.
# Assert on the STATE WORD, never on the exit status — the exit code discriminates the four states
# only once the verb has RUN, so `… || ordinary` fail-opens on a usage error (1) or a missing
# binary (127). The `else` below is the catch-all that makes that safe (formats §CP; #4161).
# The verb's INPUT is a fallible read, so it comes from §CPREAD's `cp_changed_files` (sourced above
# from ../../shared/scripts/cp-read.sh) — never a bare `gh api … |` pipe: with
# pipefail off, a failed read pipes gh's stdout ERROR BODY into the verb, which matches no §CP clause
# and answers `not-control-plane` (#4216).
if ! cp_changed_files "$REPO" "$PR"; then
  CP_STATE=unknown   # the input never arrived ⇒ UNKNOWN ⇒ held as §CP by the catch-all below
else
  CP_STATE="$(printf '%s\n' "$CP_FILES" | "$PCLI" cp-classify classify --repo "$REPO")"
fi
# `content-undetermined` is an OBLIGATION, not an answer: probe each touched ADR at head with the
# SAME ADR-0164 verb ship-it Step 0 and review-code/review-doc run. Any BLOCKING line ⇒ §CP.
if [ "$CP_STATE" = "content-undetermined" ]; then
  cp_head_sha "$REPO" "$PR"; HEAD_SHA="$CP_HEAD_SHA"   # EMPTY on failure (payload discarded) — §CPREAD
  [ -n "$HEAD_SHA" ] || echo "BLOCKING (head SHA unreadable — ADR content unprobeable ⇒ §CP, fail-closed)"
  [ -z "$HEAD_SHA" ] || printf '%s\n' "$CP_FILES" \
    | grep -E '^\.decisions/.*\.md$' | while IFS= read -r adr; do
        # Capture and CHECK, never a straight pipe — gh writes its error document to STDOUT, so a
        # pipe hands the probe an ERROR BODY as the ADR body (§CPREAD #2).
        adr_body="$(gh api "repos/$REPO/contents/$adr?ref=$HEAD_SHA" -H 'Accept: application/vnd.github.raw' 2>/dev/null)" || adr_body=""
        if [ -z "$adr_body" ]; then echo "BLOCKING ($adr — body unreadable at head ⇒ §CP, fail-closed)"
        else
          # Same rule as the cp-classify call above: assert on the probe's STATE WORD, never on its
          # exit status — an invocation that never ran would otherwise read as proven ordinary (#4219).
          GC_STATE="$(printf '%s' "$adr_body" | "$PCLI" guard-content-probe classify --path "$adr" 2>/dev/null)"
          case "$GC_STATE" in
            not-guard-touching) : ;;   # proven ordinary — the ONLY value that may skip the §CP hold
            guard-touching) echo "BLOCKING ($adr — guard-touching ADR ⇒ §CP, ADR 0164)" ;;
            *) echo "BLOCKING ($adr — probe UNDETERMINED (state '$GC_STATE') ⇒ §CP, fail-closed)" ;;
          esac
        fi
      done
elif [ "$CP_STATE" != "not-control-plane" ]; then
  # The catch-all: control-plane, unknown, AND anything unenumerated — the empty string a failed
  # invocation yields included. Only a positive `not-control-plane` may skip the hold.
  echo "BLOCKING (§CP state '$CP_STATE')"
fi
# blocking → advisory only; a control-plane approval @head → ship-it enqueues (ADR 0135; §CP set 0053/0065/0073)
