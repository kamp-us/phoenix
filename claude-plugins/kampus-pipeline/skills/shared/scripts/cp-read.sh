#!/usr/bin/env bash
# §CPREAD + §CPREAD-APPROVAL — the fallible reads every §CP site makes, extracted from
# `gh-issue-intake-formats.md` (epic #4435 phase 1, #4450). The *why* for every property asserted
# here stays in that contract's §CPREAD prose; the comments below travelled with the shell.
#
# MECHANICAL MOVE. The shell is unchanged apart from the sourcing seam and the #4510 channel fix
# below — replacing glue with `pipeline-cli` verbs is phase 2 (#1929, ADR 0228: a script may RELAY a
# verb's answer, never DERIVE the decision). Do not otherwise "improve" it here.
#
# DUAL-MODE (ADR 0232) — the why is `.patterns/skill-script-shell-shape.md` § The dual-mode shape.
#   EXECUTED:  bash ./claude-plugins/kampus-pipeline/skills/shared/scripts/cp-read.sh <REPO|ORG> \
#                   <changed-files|head-sha|team-roster|pr-author|team-membership> <PR|login>
#              stdout ⇒ one `NAME=value` line per value the matching function sets, the multi-valued
#              ones as a repeated singular key:
#                changed-files    CP_FILES_N=<n>  then one CP_FILE=<path> per file
#                head-sha         CP_HEAD_SHA=<40-hex>
#                team-roster      CP_MEMBERS_N=<n>  then one CP_MEMBER=<login> per member
#                pr-author        CP_PR_AUTHOR=<login>
#                team-membership  CP_MEMBERSHIP=<state>|absent
#              A read that could not execute prints NOTHING on stdout and exits non-zero — UNKNOWN,
#              never "no control-plane path touched".
#   SOURCED:   the sanctioned in-script edge, and the reason the functions below are untouched. Six
#              scripts source this file for them: review-code/ and review-design/
#              scripts/classify-control-plane.sh, ship-it/scripts/step0-classify.sh and
#              step0-cp-approval.sh, and this directory's cp-classify-entry.sh and cp-guard-adr.sh.
#              The three ship-it ones set NO shell options by design, which is why the options above
#              are applied in executed mode only.
# No EXIT trap — under bash 3.2 a cleanup trap's last command becomes the script's status, which
# converts a `set -u` abort into exit 0 (#4476/#4479).
#
# OUTPUT CHANNEL — every function here writes on STDERR ONLY. The rule and its why are
# `.patterns/skill-script-io-contract.md`; the instance is that these are sourced helpers whose
# result is the `CP_*` variables they leave in the caller's shell, so their stdout carries nothing
# the caller wants and a line printed there can only corrupt the caller's own answer. It did: the
# §ZS scope line used to land on stdout, and a consumer whose stdout is a machine channel sourced
# that sentence as a path (#4510). No call site needs a `>&2` — if one appears, the helper is wrong.

if [ "${BASH_SOURCE[0]}" = "$0" ]; then set -uo pipefail; fi   # executed mode only (ADR 0232)

# §CPREAD — the ONE hardened read of a PR's changed-file list, the input to BOTH §CP clauses.
# Sets CP_FILES (the list) + CP_FILES_N (the scanned count); returns NON-ZERO on a read that could
# not execute. A non-zero return is UNKNOWN — hold as §CP — never "no control-plane path touched".
# --paginate + a STREAMING --jq (one line per file) is load-bearing: gh concatenates the per-page
# element streams, so a consumer's grep aggregates matches across ALL pages. The API caps per_page at
# 100 whatever you ask for, so a single non-paginated call truncates a >100-file PR — hiding a §CP
# file in the tail. Never pair --paginate with an AGGREGATE --jq (`[ … ]` / `length` / `add`): gh runs
# the filter PER PAGE and emits one result each (#725).
cp_changed_files() {   # $1 = REPO, $2 = PR
  CP_FILES="$(gh api --paginate "repos/$1/pulls/$2/files?per_page=100" \
    --jq 'if type=="array" then .[].filename else ("payload is not a file-list array"|halt_error(1)) end' 2>/dev/null)" || {
      CP_FILES=""; CP_FILES_N=0
      echo "§CP scope: PR #$2 changed-file list READ FAILED (gh exited non-zero; payload discarded) — 0 file(s) scanned" >&2
      return 1; }
  CP_FILES_N="$(printf '%s\n' "$CP_FILES" | grep -c . || true)"
  if [ "$CP_FILES_N" -eq 0 ]; then
    CP_FILES=""
    echo "§CP scope: PR #$2 changed-file list read returned ZERO files — a PR always changes >=1 file, so this is a FAILED READ, not a clean 'no §CP path'" >&2
    return 1
  fi
  echo "§CP scope: PR #$2 changed-file list read OK — $CP_FILES_N file(s) scanned" >&2   # §ZS #1: state the scope the classification rests on
}

# The PR head SHA is the SECOND fallible read every §CP site makes — the ref the ADR-0164 content
# probe reads each ADR body at. It gets the same three properties, and for a reason worth stating
# once: `HEAD_SHA="$(gh api … --jq .head.sha || true)"` followed by `[ -n "$HEAD_SHA" ]` is a DEAD
# guard. On failure gh does not apply --jq at all — it writes its error document to STDOUT
# (property 2) — so the variable is NON-EMPTY and the emptiness test can never fire. Capture, check
# the exit status, DISCARD the payload, then shape-assert: a ref is 40 bare lowercase hex digits, so
# an error body (or any other unexpected 200) cannot pass for one.
cp_head_sha() {   # $1 = REPO, $2 = PR; sets CP_HEAD_SHA (EMPTY on failure), returns NON-ZERO ⇒ UNKNOWN
  CP_HEAD_SHA="$(gh api "repos/$1/pulls/$2" \
    --jq 'if type=="object" and (.head.sha|type)=="string" then .head.sha else ("payload is not a PR object"|halt_error(1)) end' 2>/dev/null)" || {
      CP_HEAD_SHA=""
      echo "§CP scope: PR #$2 head SHA READ FAILED (gh exited non-zero; payload discarded) — ADR content unprobeable" >&2
      return 1; }
  case "$CP_HEAD_SHA" in
    *[!0-9a-f]*|"") CP_HEAD_SHA=""; echo "§CP scope: PR #$2 head SHA is not bare hex — discarded" >&2; return 1 ;;
  esac
  [ "${#CP_HEAD_SHA}" -eq 40 ] || {
    CP_HEAD_SHA=""; echo "§CP scope: PR #$2 head SHA is not a 40-char ref — discarded" >&2; return 1; }
}

# cp_team_roster — the control-plane roster read. Sets CP_MEMBERS (logins, one per line) +
# CP_MEMBERS_N; returns NON-ZERO ⇒ UNKNOWN (never a cardinality). A read that SUCCEEDS and returns
# zero members is a DIFFERENT, honest state — the ADR-0175 N==0 STOP — and returns zero here, so the
# §ZS zero-scope rule does NOT apply: unlike a PR's file list, an empty team is a real answer.
cp_team_roster() {   # $1 = ORG
  CP_MEMBERS="$(gh api --paginate "orgs/$1/teams/control-plane/members?per_page=100" \
    --jq 'if type=="array" then .[].login else ("payload is not a member array"|halt_error(1)) end' 2>/dev/null)" || {
      CP_MEMBERS=""; CP_MEMBERS_N=0
      echo "§CP roster: @$1/control-plane member list READ FAILED (gh exited non-zero; payload discarded) — roster UNKNOWN, NOT empty" >&2
      return 1; }
  # Shape, then interpret. A status check alone still admits a 200 carrying something that is not a
  # roster; a bare non-empty test admits the error blob outright. Only the login charset rejects both.
  if printf '%s\n' "$CP_MEMBERS" | grep -qvE '^[A-Za-z0-9-]*$'; then
    CP_MEMBERS=""; CP_MEMBERS_N=0
    echo "§CP roster: @$1/control-plane member list carries a non-login entry — payload discarded, roster UNKNOWN, NOT empty" >&2
    return 1
  fi
  CP_MEMBERS_N="$(printf '%s\n' "$CP_MEMBERS" | grep -c . || true)"
  echo "§CP roster: @$1/control-plane read OK — $CP_MEMBERS_N member(s) scanned" >&2   # §ZS #1: emit the scope
}

# cp_pr_author — the PR author login. An unresolved author is UNKNOWN: it un-skips the author in the
# approver walk (a self-approval would count as a non-author approval) and mis-keys the cardinality
# branch. Same dead-guard reason as cp_head_sha: on failure gh writes its error document to STDOUT,
# so `[ -n "$AUTHOR" ]` can never fire — check the status, discard the payload, then shape-assert.
cp_pr_author() {   # $1 = REPO, $2 = PR; sets CP_PR_AUTHOR (EMPTY on failure), NON-ZERO ⇒ UNKNOWN
  CP_PR_AUTHOR="$(gh api "repos/$1/pulls/$2" \
    --jq 'if type=="object" and (.user.login|type)=="string" then .user.login else ("payload is not a PR object"|halt_error(1)) end' 2>/dev/null)" || {
      CP_PR_AUTHOR=""
      echo "§CP author: PR #$2 author READ FAILED (gh exited non-zero; payload discarded) — author UNKNOWN" >&2
      return 1; }
  case "$CP_PR_AUTHOR" in
    ""|*[!A-Za-z0-9-]*) CP_PR_AUTHOR=""
      echo "§CP author: PR #$2 author is not a bare login — discarded, author UNKNOWN" >&2; return 1 ;;
  esac
}

# cp_team_membership — is login $2 on @$1/control-plane? THREE outcomes, not two: `-i` keeps the
# status line on stdout even when gh exits non-zero, which is the whole point — a 404 is a DEFINITE
# non-member, anything else is UNKNOWN. The bare `--jq '.state' 2>/dev/null` this replaces made a
# 5xx indistinguishable from a definite non-member, silently under-counting an approver.
# Composition, measured: an ABSENT team namespace 404s here too, so this endpoint alone cannot tell
# "not a member of a team that exists" from "no such team". It does not have to — call it only after
# cp_team_roster has proven the team readable, which is what makes a 404 here definite.
cp_team_membership() {   # $1 = ORG, $2 = login; sets CP_MEMBERSHIP = <state>|absent; NON-ZERO ⇒ UNKNOWN
  _resp="$(gh api "orgs/$1/teams/control-plane/memberships/$2" -i 2>/dev/null)"; _rc=$?
  _status="$(printf '%s\n' "$_resp" | head -n1 | awk '{print $2}')"   # $? already stashed above
  case "$_status" in
    200)
      CP_MEMBERSHIP="$(printf '%s\n' "$_resp" | awk 'b{print} /^\r?$/{b=1}' \
        | jq -r 'if type=="object" and (.state|type)=="string" then .state else ("payload is not a membership object"|halt_error(1)) end' 2>/dev/null)" || {
          CP_MEMBERSHIP=""
          echo "§CP membership: '$2' returned 200 with a non-membership payload — discarded, membership UNKNOWN" >&2
          return 1; }
      return 0 ;;
    404) CP_MEMBERSHIP=absent; return 0 ;;
    *)   CP_MEMBERSHIP=""
      echo "§CP membership: '$2' on @$1/control-plane READ FAILED (HTTP ${_status:-none}, gh exit $_rc) — UNKNOWN, NOT a definite non-member" >&2
      return 1 ;;
  esac
}

# The ADR-0232 executed entry. It RELAYS each function's result onto stdout and its status onto the
# exit code; it adds no branch of its own, so the executed and sourced answers cannot diverge.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  _target="${1:?cp-read.sh: no <REPO|ORG> argument — refusing to read against an unnamed target}"
  case "${2-}" in
    changed-files)
      cp_changed_files "$_target" "${3:?cp-read.sh changed-files: no PR number}" || exit 1
      printf 'CP_FILES_N=%s\n' "$CP_FILES_N"
      printf '%s\n' "$CP_FILES" | while IFS= read -r _f; do
        [ -n "$_f" ] && printf 'CP_FILE=%s\n' "$_f"
      done
      ;;
    head-sha)
      cp_head_sha "$_target" "${3:?cp-read.sh head-sha: no PR number}" || exit 1
      printf 'CP_HEAD_SHA=%s\n' "$CP_HEAD_SHA"
      ;;
    team-roster)
      # Zero members is a FACT here, not a failed read (the ADR-0175 N==0 STOP), so this branch
      # legitimately prints `CP_MEMBERS_N=0` and no CP_MEMBER lines at exit 0 — the asymmetry with
      # changed-files above is deliberate (`.patterns/skill-script-io-contract.md`).
      cp_team_roster "$_target" || exit 1
      printf 'CP_MEMBERS_N=%s\n' "$CP_MEMBERS_N"
      printf '%s\n' "$CP_MEMBERS" | while IFS= read -r _m; do
        [ -n "$_m" ] && printf 'CP_MEMBER=%s\n' "$_m"
      done
      ;;
    pr-author)
      cp_pr_author "$_target" "${3:?cp-read.sh pr-author: no PR number}" || exit 1
      printf 'CP_PR_AUTHOR=%s\n' "$CP_PR_AUTHOR"
      ;;
    team-membership)
      cp_team_membership "$_target" "${3:?cp-read.sh team-membership: no login}" || exit 1
      printf 'CP_MEMBERSHIP=%s\n' "$CP_MEMBERSHIP"
      ;;
    *)
      echo "usage: cp-read.sh <REPO|ORG> <changed-files|head-sha|team-roster|pr-author|team-membership> <PR|login>" >&2
      exit 2 ;;
  esac
fi
