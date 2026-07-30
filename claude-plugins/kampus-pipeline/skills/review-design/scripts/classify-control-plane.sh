#!/usr/bin/env bash
# Classify the PR blocking (§CP) vs non-blocking. Prints one or more `BLOCKING (…)` lines when the
# PR is held as §CP; prints NO `BLOCKING (…)` line when the canonical verb answered a positive
# `not-control-plane`. Note stdout is NOT empty on that path — `cp_changed_files` emits its §ZS scope
# line there — so the absent BLOCKING line, not empty output, is the discriminator.
# Extracted from review-design/SKILL.md (#4453, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
#
# BECAUSE the caller reads the ABSENCE of a `BLOCKING (…)` line as the one positive
# `not-control-plane` answer, every path that returns before the classifier runs MUST print its own
# `BLOCKING (…)` line first. A guard that could not run is UNKNOWN, and UNKNOWN is not "no" (§ZS /
# ADR 0092; #4231, #4010, #4219) — a bare `exit` here would let a usage error or a failed `kp_repo`
# read pose as "proven ordinary".
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"
# §CPREAD's `cp_changed_files` + `cp_head_sha`, sourced from their canonical home — no skill-local
# copy to drift (#4489 extracted them out of `../../gh-issue-intake-formats.md`).
# shellcheck source=../../shared/scripts/cp-read.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/scripts" && pwd)/cp-read.sh"

[ "$#" -ge 1 ] || {
	echo "BLOCKING (classifier could not run — no <pr> argument ⇒ §CP, fail-closed)"
	echo "usage: classify-control-plane.sh <pr>" >&2
	exit 2
}
PR="$1"
# Top-level assignment, never `local` — a `local REPO="$(kp_repo)"` takes `local`'s own status and
# masks the substitution's, so the guard below would never fire (the kp_repo idiom's gotcha).
REPO="$(kp_repo)" || {
	echo "BLOCKING (classifier could not run — target repo unresolved ⇒ §CP, fail-closed)"
	exit 1
}
# §CLI — the shim resolved by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314). An UNRESOLVED
# shim (kp_pcli exit 127) leaves PCLI empty, so the classification below captures an EMPTY state word
# and the catch-all holds the PR as §CP — the same fail-closed outcome the block documents for "a
# `pipeline-cli` that is not on PATH and exits 127". "Could not run" is never `not-control-plane`.
PCLI="$(kp_pcli)" || PCLI=""

# Four states on stdout. Assert on the STATE WORD, never on the exit status — the exit code
# discriminates the four states only once the verb has RUN, so `… || ordinary` fail-opens on a
# usage error (1) or a missing binary (127). The `else` below is the catch-all (formats §CP; #4161).
# The verb's INPUT is a fallible read, so it comes from §CPREAD's `cp_changed_files` (sourced above
# from `../../shared/scripts/cp-read.sh` alongside `cp_head_sha`) — never a bare `gh api … |` pipe:
# with pipefail off, a failed read pipes gh's stdout ERROR BODY into the verb, which matches no §CP
# clause and answers `not-control-plane` (#4216).
if ! cp_changed_files "$REPO" "$PR"; then
  CP_STATE=unknown   # the input never arrived ⇒ UNKNOWN ⇒ held as §CP by the catch-all below
else
  CP_STATE="$(printf '%s\n' "$CP_FILES" | "$PCLI" cp-classify classify --repo "$REPO")" || CP_STATE=""
fi
# `content-undetermined` is an OBLIGATION, not an answer: probe each listed ADR at head before
# calling this PR non-blocking (the same ADR-0164 verb ship-it Step 0 and review-code/doc run).
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
