#!/usr/bin/env bash
# Step 2 — the §CP merge-blocking flag: the path clause (CONTROL_PLANE_RE, re-resolved from
# origin/main) and the ADR-0164 content clause (guard-touching `.decisions/**`). Extracted from
# review-code/SKILL.md (#4451, epic #4435 phase 1). Extraction contract + shell-option rationale:
# ../SKILL.md § The extracted scripts. The *why* for each clause stays in that step's prose.
#
# usage: bash ./claude-plugins/kampus-pipeline/skills/review-code/scripts/classify-control-plane.sh <pr>
#
# STDOUT IS THE ANSWER (ADR 0232, .patterns/skill-script-io-contract.md) — four `KEY=value` lines:
#   CONTROL_PLANE_TOUCHED / GUARD_TOUCHING   the two flags Step 4a branches on, `printf '%q'`-quoted
#   CP_FILES_N / ADR_N                       the §ZS scope counts
# The two flags are %q-quoted for two reasons: a multi-file match stays ONE line, and the ordinary
# not-§CP answer arrives as the positive token `''` rather than as an absence Step 4a has to infer
# (.patterns/skill-script-io-contract.md, "the positive answer must be a positive token"). Scope +
# diagnostic lines go to stderr; the §CPREAD helpers keep stdout clean themselves, so no call site
# below redirects — an un-redirected `cp_changed_files` is what put a scope sentence ahead of the
# answer and got it read as one (#4510).
#
# EVERY failure path PRINTS THE FLAGS AS THE §CP SENTINEL FIRST, then exits non-zero. That is the
# whole reason this script exists in this shape: an empty `$CONTROL_PLANE_TOUCHED` is what Step 4a
# reads as "auto-mergeable", so a classifier that could not run must never reach the caller as an
# unset/empty flag. An absent or empty result is UNKNOWN, and UNKNOWN is never "no §CP path touched"
# (§ZS / ADR 0092; #4216, #4231, #4010, #4219). Under ADR 0232 stdout carries the answer directly, so
# there is no run-state handle left to fail to open — the sentinel now reaches the caller on EVERY
# path, including the one where the §SP namespace itself is unavailable.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"
# §CPREAD's `cp_changed_files` + `cp_head_sha`, sourced from their canonical home — no skill-local
# copy to drift (#4489 extracted them out of ../../gh-issue-intake-formats.md, which is why the step
# prose no longer says "copy them verbatim").
# shellcheck source=../../shared/scripts/cp-read.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/scripts" && pwd)/cp-read.sh"

# ASCII punctuation in every EMITTED string below, deliberately: bash 3.2's `printf %q` escapes a
# 3-byte UTF-8 sequence half-raw (`—` becomes a raw 0xE2 then `\200\224`), which round-trips through
# a `.` but renders as mojibake on the stdout an agent now READS. `§` is 2-byte and survives, so the
# canonical §CP term stays; the em-dashes and `⇒` do not. Measured on bash 3.2.57, macOS.
SENTINEL="<§CP classifier could not run - §CP UNKNOWN, held as control-plane>"
# emit_and_exit <status> <control-plane-touched> <guard-touching> <cp-files-n> <adr-n>
# The ONLY writer of this script's stdout, so every exit — success, usage error, blinded read —
# leaves the caller a readable flag pair rather than 0 bytes it would have to interpret.
emit_and_exit() {
  printf 'CONTROL_PLANE_TOUCHED=%q\n' "$2"
  printf 'GUARD_TOUCHING=%q\n' "$3"
  printf 'CP_FILES_N=%s\n' "$4"
  printf 'ADR_N=%s\n' "$5"
  exit "$1"
}

# The declared lines carry bash 3.2.57's `%q` escaping (the platform measured above); bash 5 quotes
# the same string differently, so a mismatch here on another bash is the escaping, not a lost sentinel.
# usage-miss-sentinel: CONTROL_PLANE_TOUCHED=\<§CP\ classifier\ could\ not\ run\ -\ §CP\ UNKNOWN\,\ held\ as\ control-plane\>
# usage-miss-sentinel: GUARD_TOUCHING=\<§CP\ classifier\ could\ not\ run\ -\ §CP\ UNKNOWN\,\ held\ as\ control-plane\>
# usage-miss-sentinel: CP_FILES_N=0
# usage-miss-sentinel: ADR_N=0
[ "$#" -ge 1 ] || { echo "usage: classify-control-plane.sh <pr>" >&2; emit_and_exit 2 "$SENTINEL" "$SENTINEL" 0 0; }
PR="$1"
# Top-level assignment, never `local` — `local REPO="$(kp_repo)"` masks the substitution's status,
# and this guard's whole job is to catch it.
REPO="$(kp_repo)" || emit_and_exit 1 "$SENTINEL" "$SENTINEL" 0 0
PCLI="$(kp_pcli)" || PCLI=""

# §CP travels in the INJECTED skill snapshot, which can lag origin/main even when the on-disk file
# is current — a pre-amendment snapshot once mis-classified a now-control-plane PR (#981).
# §CP boundary is single-sourced in pipeline-cli (control-plane-paths/control-plane-re.ts, #2761);
# run `pipeline-cli control-plane-paths` to print it. It is re-resolved from origin/main right below
# (the #981 anti-self-authorization read), so this is only a fail-closed sentinel, never the live source.
CONTROL_PLANE_RE='.'   # fail-closed default: every path is control-plane until origin/main resolves
# Re-resolve §CP from origin/main at run time so a stale snapshot can't mis-flag a now-control-plane
# PR as auto-mergeable (#981). ADR 0073 §6 names gh-issue-intake-formats.md the single source; read it
# freshly via REST raw (never GraphQL). origin/main's line wins over the snapshot; fail closed on read failure.
CP_LIVE="$(gh api "repos/$REPO/contents/claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md?ref=main" -H 'Accept: application/vnd.github.raw' 2>/dev/null | grep '^CONTROL_PLANE_RE=' | head -n1 || true)"
if [ -n "$CP_LIVE" ]; then
  CONTROL_PLANE_RE="$(printf '%s' "$CP_LIVE" | sed "s/^CONTROL_PLANE_RE='//; s/'$//")"   # the flag tracks origin/main, not the snapshot's age (AC1/AC2)
else
  CONTROL_PLANE_RE='.'   # FAIL CLOSED: can't read origin/main's boundary ⇒ flag EVERY path control-plane (not-auto-mergeable), never trust the possibly-stale snapshot
fi
# ONE hardened read of the changed-file list, feeding BOTH §CP clauses below. `cp_changed_files` is
# §CPREAD of ../gh-issue-intake-formats.md — exit-status-checked, shape-asserted, scope-emitting; a
# non-zero return means the read COULD NOT EXECUTE, which is UNKNOWN, not "no §CP path touched". Read
# the why there once; do not re-derive it here. It also removes the second read this step used to make
# (the GUARD_TOUCHING loop re-fetched the same list), so both clauses now see the same scanned scope.
if ! cp_changed_files "$REPO" "$PR"; then
  # FAIL CLOSED (#4216): a blinded read blinds BOTH clauses at once — the path regex AND the ADR-0164
  # content probe, which is the only §CP signal a `.decisions/**`-only PR can produce. So resolve BOTH
  # toward §CP; the sentinel is non-empty, which is exactly what Step 4a branches on.
  CONTROL_PLANE_TOUCHED="<changed-file list unreadable - §CP UNKNOWN, held as control-plane>"
  GUARD_TOUCHING="<changed-file list unreadable - §CP UNKNOWN, held as control-plane>"
  emit_and_exit 1 "$CONTROL_PLANE_TOUCHED" "$GUARD_TOUCHING" "${CP_FILES_N:-0}" 0
else
  # grep aggregates the §CP matches ACROSS the concatenated pages — a jq `[ … ]` aggregate would
  # instead emit one array PER PAGE. `|| true` here is now safe and means ONLY what it says: no §CP
  # match is grep exit 1 over a list that was PROVEN to arrive (#725 + #4216).
  CONTROL_PLANE_TOUCHED="$(printf '%s\n' "$CP_FILES" | grep -E "$CONTROL_PLANE_RE" || true)"
  # non-empty → control-plane: emit the advisory line in the verdict (Step 4a) per ADR 0053/0065/0073
  # §CP by CONTENT (ADR 0164): a touched .decisions/** ADR is not path-§CP, but a guard-RELAXING one is
  # control-plane by nature. Probe each ADR's content at head with the SHARED `guard-content-probe` verb
  # — the SAME probe ship-it Step 0, review-doc, and the driver (via trivial-diff) call, so a guard-touching
  # ADR reads §CP consistently everywhere (issue #3645, founder ruling #3416). A mixed code+guard-ADR PR
  # fans BOTH gates; either flagging the ADR carries the §CP merge-authority hold.
  # The ref is a fallible read too — `cp_head_sha` is §CPREAD's companion to `cp_changed_files`
  # (sourced above from ../../shared/scripts/cp-read.sh). It leaves HEAD_SHA EMPTY on failure by
  # DISCARDING gh's payload, which is what makes the `[ -n ]` test below a live guard rather than a dead one.
  cp_head_sha "$REPO" "$PR"; HEAD_SHA="$CP_HEAD_SHA"
  # Assert on the probe's STATE WORD, never on its exit status — the exit code discriminates the two
  # verdicts only once the verb has RUN, so the old `>/dev/null && …` shape accumulated NOTHING when it
  # never ran (bad flag / nested-cwd module-not-found / missing shim) and read an unprobed ADR as
  # ordinary. The `*)` arm keeps could-not-determine a HOLD, exactly as an unreadable body is (#4219).
  GUARD_TOUCHING=""
  [ -n "$HEAD_SHA" ] || GUARD_TOUCHING="<head SHA unreadable - ADR content unprobeable, held as control-plane>"   # fail closed: no ref ⇒ no probe ⇒ UNKNOWN
  ADR_N=0
  while IFS= read -r adr; do
    [ -z "$adr" ] && continue
    [ -n "$HEAD_SHA" ] || break
    ADR_N=$((ADR_N + 1))
    # Capture and CHECK before classifying, never a straight pipe — §CPREAD #2.
    adr_body="$(gh api "repos/$REPO/contents/$adr?ref=$HEAD_SHA" -H 'Accept: application/vnd.github.raw' 2>/dev/null)" || adr_body=""
    if [ -z "$adr_body" ]; then
      GUARD_TOUCHING="$GUARD_TOUCHING $adr(body-unreadable=>§CP)"   # fail closed: never auto-ship an ADR that could not be read and proven guard-free
    else
      GC_STATE="$(printf '%s' "$adr_body" | "$PCLI" guard-content-probe classify --path "$adr" 2>/dev/null)"
      case "$GC_STATE" in
        not-guard-touching) : ;;   # proven ordinary — the ONLY value that may skip the §CP hold
        guard-touching) GUARD_TOUCHING="$GUARD_TOUCHING $adr" ;;
        *) GUARD_TOUCHING="$GUARD_TOUCHING $adr(undetermined:'$GC_STATE')" ;;
      esac
    fi
  done < <(printf '%s\n' "$CP_FILES" | grep -E '^\.decisions/.*\.md$' || true)
  echo "§CP scope: $CP_FILES_N file(s) scanned, $ADR_N .decisions/** ADR(s) content-probed" >&2   # §ZS #1 (ADR 0092): a §CP classification always states its scope
fi
# non-empty $GUARD_TOUCHING → §CP-advisory, same as CONTROL_PLANE_TOUCHED above (Step 4a; ADR 0164/0135)
emit_and_exit 0 "$CONTROL_PLANE_TOUCHED" "$GUARD_TOUCHING" "$CP_FILES_N" "$ADR_N"
