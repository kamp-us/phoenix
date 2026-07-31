#!/usr/bin/env bash
# Step 0 — the fail-closed triviality re-affirm: the §CP path/content classification and the §DEV
# disclosure premise. Extracted from review-trivial/SKILL.md (#4453, epic #4435 phase 1). Extraction
# contract + shell-option rationale: ../SKILL.md § The extracted scripts. The *why* for each clause
# stays in that step's prose.
#
# STDOUT IS THE ANSWER, AND ITS EMPTY STATE IS THE PERMISSIVE ONE. Any `review-trivial: not-trivial
# — …` line on stdout means "route to the full path"; EMPTY stdout with exit 0 means the triviality
# premise held. That inversion is why every could-not-run path here PRINTS a `not-trivial` line
# BEFORE exiting, and exits non-zero: a classifier that never ran must never reach the caller as
# silence, which the caller would read as "proven trivial" and under-gate (§ZS / ADR 0092,
# `.patterns/skill-script-io-contract.md`; #4216, #4161, #4219). Scope + diagnostics go to stderr.
#
# BASH 3.2 NOTE, load-bearing: the ADR-0164 probe loop below sits inside a `$( … )`, and bash 3.2
# balances parens across the WHOLE substitution body — including inside comments, where a lone `(`
# or `)` is counted as if it were syntax. Two consequences, both measured on 3.2.57(1)-release:
# every `case` pattern in there carries the POSIX leading `(` (otherwise the pattern's closing `)`
# ends the substitution early), and no comment in there may carry an unbalanced paren. Neither
# hazard was reachable while this block lived inline in the markdown and never ran, and CI's bash 5
# parses both shapes — so CI cannot catch either. The local interpreter every agent run gets is the
# one that decides (`.patterns/skill-script-shell-shape.md`).
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
  echo "review-trivial: not-trivial — step0-triviality.sh ran with no <pr> argument, so nothing was classified; route to full path"
  echo "usage: step0-triviality.sh <pr>" >&2; exit 2; }
PR="$1"
REPO="$(kp_repo)" || {
  echo "review-trivial: not-trivial — target repo unresolvable, so §CP could not be classified (UNKNOWN, never 'ordinary'); route to full path"
  exit 1; }
# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="$(kp_pcli)" || {
  echo "review-trivial: not-trivial — the CLI shim is UNRESOLVED, so cp-classify never ran (UNKNOWN, never 'ordinary'); route to full path"
  exit 127; }

# The changed-file list is a fallible READ, and an unchecked capture resolved a failed one to "no §CP
# path touched" (#4216) — at the gate that routes to the LIGHTER path, so a fail-open here UNDER-gates.
# `cp_changed_files` / `cp_head_sha` are §CPREAD, sourced above from ../../shared/scripts/cp-read.sh
# (single source; the why lives in ../../gh-issue-intake-formats.md, not here).
if ! cp_changed_files "$REPO" "$PR"; then
  echo "review-trivial: not-trivial — changed-file list unreadable (§CP UNKNOWN, never 'no §CP path'); route to full path"; exit 1
fi
FILES="$CP_FILES"; NFILES="$CP_FILES_N"   # proven-arrived; scope already emitted per §ZS #1 (ADR 0092)
ADD=$(gh api repos/"$REPO"/pulls/"$PR" --jq '.additions'); DEL=$(gh api repos/"$REPO"/pulls/"$PR" --jq '.deletions')
# The size facts feed the verdict's triviality-re-affirm evidence row. They go to STDERR because
# stdout is the not-trivial channel and an extra line there would read as a hold (the seam the
# fenced block did not have: it left $NFILES/$ADD/$DEL in the caller's shell, retired by ADR 0232).
echo "review-trivial scope: $NFILES file(s), +${ADD:-?}/-${DEL:-?}" >&2

# Four states on stdout: control-plane / content-undetermined / not-control-plane / unknown.
# Only `not-control-plane` is a proven-ordinary answer; every other state is a HOLD.
CP_STATE="$(printf '%s\n' "$FILES" | "$PCLI" cp-classify classify --repo "$REPO")"
# Fail-closed on EVERY value but the proven-ordinary one. The test is a positive match on the
# STATE WORD, not on the exit status: the exit code discriminates the four states only once the
# verb has RUN, so a bad flag (exit 1) or a missing binary (exit 127) would fail OPEN through
# `… || ordinary`. Here they leave CP_STATE empty, which this test routes to the full path (#4161).
if [ "$CP_STATE" != "not-control-plane" ]; then
  # Resolve the one state that is an obligation rather than a verdict (ADR 0164, #4161).
  if [ "$CP_STATE" = "content-undetermined" ]; then
    cp_head_sha "$REPO" "$PR"; HEAD_SHA="$CP_HEAD_SHA"   # EMPTY on failure (payload discarded) — §CPREAD
    if [ -z "$HEAD_SHA" ]; then
      echo "review-trivial: not-trivial — head SHA unreadable, ADR content unprobeable (§CP UNKNOWN); route to full path"; exit 1
    fi
    # Assert on the probe's STATE WORD, never on its exit status: the exit code discriminates the
    # two verdicts only once the verb has RUN, so `>/dev/null && echo "$adr"` collected NOTHING when
    # it never ran and read an unprobed ADR as ordinary. Only `not-guard-touching` clears (#4219).
    GUARD_TOUCHING="$(printf '%s\n' "$FILES" | grep -E '^\.decisions/.*\.md$' | while IFS= read -r adr; do
        # Capture and CHECK, never a straight pipe: gh writes its error document to STDOUT, so a pipe
        # hands the probe an ERROR BODY as the ADR body (§CPREAD #2). Unreadable ⇒ §CP, fail-closed.
        adr_body="$(gh api "repos/$REPO/contents/$adr?ref=$HEAD_SHA" -H 'Accept: application/vnd.github.raw' 2>/dev/null)" || adr_body=""
        if [ -z "$adr_body" ]; then echo "$adr(body-unreadable⇒§CP)"
        else
          GC_STATE="$(printf '%s' "$adr_body" | "$PCLI" guard-content-probe classify --path "$adr" 2>/dev/null)"
          # The pattern prefixes below are REQUIRED — see the header note on bash 3.2.
          case "$GC_STATE" in
            (not-guard-touching) : ;;
            (guard-touching) echo "$adr" ;;
            (*) echo "$adr(undetermined:'$GC_STATE')" ;;
          esac
        fi
      done)"
    if [ -z "$GUARD_TOUCHING" ]; then
      : # every touched ADR probed not-guard-touching ⇒ the content axis is resolved, carry on
    else
      echo "review-trivial: not-trivial — ADR not proven ordinary by content (guard-touching, or the probe could not determine; ADR 0164): $GUARD_TOUCHING; route to full path"; exit 0
    fi
  else
    echo "review-trivial: not-trivial — §CP state '$CP_STATE'; route to full path (ADR 0053/0065; #4161)"; exit 0
  fi
fi

# §DEV: the disclosure section decides triviality too — a disclosed deviation, or a missing heading,
# routes to the full path. Read the section's body (heading → next heading or EOF) and compare.
BODY="$(gh api repos/"$REPO"/pulls/"$PR" --jq '.body')" || {
  echo "review-trivial: not-trivial — PR body unreadable, so the §DEV None. premise is unprovable; route to full path"; exit 1; }
# `IGNORECASE` is a gawk extension BSD/macOS awk ignores SILENTLY, so a lowercase `## deviations`
# heading yielded an empty DEV_BODY here while the case-insensitive `grep -i` below still saw the
# heading — the two halves disagreed about case. Spell the case-insensitivity into the pattern
# instead (POSIX, portable) so both halves read the same heading.
DEV_BODY="$(printf '%s\n' "$BODY" \
  | awk '/^[[:space:]]*###?[[:space:]]*[Dd][Ee][Vv][Ii][Aa][Tt][Ii][Oo][Nn][Ss][[:space:]]*$/{f=1;next} /^[[:space:]]*##?#?[[:space:]]/{f=0} f' \
  | grep -Ev '^[[:space:]]*$')"
if ! printf '%s\n' "$BODY" | grep -Eiq '^[[:space:]]*#{2,3}[[:space:]]*Deviations[[:space:]]*$'; then
  echo "review-trivial: not-trivial — no ## Deviations section, so no None. claim to stand on (§DEV); route to full path, which decides owed-vs-not"; exit 0
elif [ "$(printf '%s\n' "$DEV_BODY" | grep -c .)" = 1 ] && printf '%s\n' "$DEV_BODY" | grep -Eiqx '[[:space:]]*none\.?[[:space:]]*'; then
  : # exactly one non-blank line, and it is `None.` — the triviality premise holds, continue Step 0
else
  # anything else — a disclosed deviation, OR an empty section (which is not the `None.` claim §DEV
  # requires) — is outside the lighter gate's bound. Default-deny, exactly like the unreadable
  # CONTROL_PLANE_RE above: you cannot prove the premise, so you must not treat the diff as trivial.
  echo "review-trivial: not-trivial — the body discloses a deviation, or its ## Deviations section is empty (§DEV); route to full path"; exit 0
fi
