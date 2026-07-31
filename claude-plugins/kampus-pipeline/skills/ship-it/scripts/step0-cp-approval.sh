#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2046
# The deterministic §CP discharge — control-plane team cardinality plus the two current-head signals (ADR 0175).
#
# Extracted VERBATIM from ship-it/SKILL.md's Step 0's §CP approval gate fenced block (epic #4435 phase 1, #4448).
# A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2 (#1929).
#
# SOURCED, never executed. The fenced block it replaces ran inline in the agent's shell, so this
# file deliberately sets NO shell options — several guards here depend on `pipefail` being OFF —
# and leaves its variables and functions in the sourcing shell, which is how the step's later
# blocks still see them.
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"
# §CPREAD + §CPREAD-APPROVAL's `cp_team_roster` / `cp_pr_author` / `cp_head_sha` /
# `cp_team_membership`, sourced IN-CHAIN. SKILL.md documents a verbatim-paste precondition ahead of
# this step, which is a real precondition but still a hand step the shipper has to remember — the
# same one line that repairs its two naked siblings discharges it structurally here too (#4547).
# shellcheck source=../../shared/scripts/cp-read.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/scripts" && pwd)/cp-read.sh"

# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/bin/pipeline-cli"
# ADR 0175: DETERMINISTIC §CP discharge keyed on control-plane team cardinality, not judgment.
ORG="${REPO%%/*}"                                            # owner half of owner/repo
# The one non-firing exit that is NOT a definite answer: it names the read that could not execute,
# so a broken read is never reported as a human-approval wait (#4223).
cp_unknown() { echo "§CP approval: STOP — $1 UNKNOWN (read failed); the discharge is UNRESOLVED, NOT 'awaiting control-plane approval' (ADR 0175, #4223)" >&2; }

# N = present, active, human control-plane members (REST, never GraphQL — ADR 0135/0175).
# A SUCCESSFUL read of an empty team still flows through to cp-cardinality's honest N==0 STOP; only
# an UNREADABLE roster stops here, because those are different facts with the same outcome.
cp_team_roster "$ORG" || { cp_unknown "the @$ORG/control-plane roster"; exit 1; }
MEMBERS="$CP_MEMBERS"
cp_pr_author "$REPO" "$PR" || { cp_unknown "the PR author"; exit 1; }
AUTHOR="$CP_PR_AUTHOR"
cp_head_sha "$REPO" "$PR" || { cp_unknown "the PR head SHA"; exit 1; }
HEAD="$CP_HEAD_SHA"                                          # every signal binds THIS head (ADR 0058)

# Bidirectional prefix match so a 7-hex short SHA binds a 40-hex head — but ONLY once BOTH sides
# are proven hex. With $HEAD empty the second pattern degenerates to `*` and binds ANY candidate,
# so a self-approval marker on a superseded head counts as current (#4223). Asserting $HEAD is
# duplicated work given cp_head_sha above, and it stays: this matcher is the last thing between a
# stale marker and a discharge, so it proves its own precondition rather than inheriting it.
# The reverse direction is unreachable while that 40-hex assertion holds (a candidate can only be
# a prefix OF a full head, never the other way round); kept so the matcher's shape is unchanged and
# the assertion is the only thing this fix takes away from its reach.
sha_binds_head() {
  case "$HEAD" in *[!0-9a-f]*|"") return 1;; esac
  [ "${#HEAD}" -eq 40 ] || return 1
  case "$1" in *[!0-9a-f]*|"") return 1;; esac
  [ "${#1}" -ge 7 ] || return 1
  case "$HEAD" in "$1"*) return 0;; esac
  case "$1" in "$HEAD"*) return 0;; esac
  return 1
}

# Signal 1 — a current-head APPROVED review by a control-plane member who is NOT the author
# (the N>=2 and N==1-sole!=author discharge). Latest review per author, APPROVED, commit_id == HEAD.
NON_AUTHOR_APPROVAL_AT_HEAD=false
MEMBERSHIP_UNKNOWN=false
CURRENT_APPROVERS="$(gh api --paginate "repos/$REPO/pulls/$PR/reviews?per_page=100" \
  --jq "group_by(.user.login) | map(max_by(.submitted_at))
        | map(select(.state == \"APPROVED\" and .commit_id == \"$HEAD\") | .user.login) | .[]")" \
  || { cp_unknown "the PR's review list"; exit 1; }
while IFS= read -r u; do
  [ -z "$u" ] && continue
  # cp_pr_author proved $AUTHOR is a bare login, so this skip cannot silently stop skipping. The
  # assertion is kept at the skip itself because THAT is where an unresolved author would let a
  # self-approval count as a non-author approval — the one direction that is not safe (#4223).
  : "${AUTHOR:?§CP approval: author unresolved at the approver walk — refusing to count approvals}"
  [ "$u" = "$AUTHOR" ] && continue                          # self-approval never counts here (ADR 0175)
  # THREE outcomes: active member, definite non-member (404), or UNKNOWN. An UNKNOWN probe must not
  # silently under-count into a `stop` that reads as "awaiting approval" — record it and keep
  # scanning, since a LATER approver proving `active` still discharges honestly.
  if cp_team_membership "$ORG" "$u"; then
    [ "$CP_MEMBERSHIP" = "active" ] && { NON_AUTHOR_APPROVAL_AT_HEAD=true; break; }
  else
    MEMBERSHIP_UNKNOWN=true
  fi
done <<<"$CURRENT_APPROVERS"
if [ "$NON_AUTHOR_APPROVAL_AT_HEAD" = false ] && [ "$MEMBERSHIP_UNKNOWN" = true ]; then
  cp_unknown "at least one approver's control-plane membership"; exit 1
fi

# Signal 2 — a deliberate current-head self-approval MARKER by the sole owner (the ONLY N==1
# sole-owner discharge). GitHub records no native self-approval, so the signal is a marker comment:
# first line `control-plane-self-approval @ <sha>` — a DISTINCT token from the review-* markers, so
# it can never leak a §CP PR into the auto-merge namespace (ADR 0111) — authored by the sole owner
# and SHA-bound to the current head. The sole owner posts it to consciously self-approve their own
# §CP PR; it is inert unless N==1 and they are the author (cp-cardinality ignores it otherwise).
# Capture, CHECK, then pipe the variable: `pipefail` is off in the agent shell, so piping `gh`
# straight into `grep` reports grep's status and discards the read's (§CPREAD #1).
SELF_APPROVAL_AT_HEAD=false
SELF_MARKERS="$(gh api --paginate "repos/$REPO/issues/$PR/comments?per_page=100" \
  --jq "[.[] | select(.user.login == \"$AUTHOR\")
             | select(.body | test(\"(?i)^\\\\s*\\\\**\\\\s*control-plane-self-approval\\\\b\"))]
        | last | .body // \"\"")" \
  || { cp_unknown "the PR's comment list"; exit 1; }
# `tail -n1`, not `head`: --paginate runs this aggregate --jq PER PAGE and emits one body each, in
# page order, so the LAST match is the latest marker — `head` would pin page 1's older one (#725).
SELF_SHA="$(printf '%s\n' "$SELF_MARKERS" \
  | grep -ioE 'control-plane-self-approval[[:space:]]*@?[[:space:]]*[0-9a-f]{7,40}' \
  | grep -ioE '[0-9a-f]{7,40}' | tail -n1)"
sha_binds_head "$SELF_SHA" && SELF_APPROVAL_AT_HEAD=true

# The DETERMINISTIC decision — the whole ADR-0175 `case "$N"` branch lives in the tested pure core.
# discharge → carry on to the machine gates; stop → STOP (fail closed). Pass a signal flag only when
# that signal is present at head; cp-cardinality selects which signal the branch actually requires.
# The §CP discharge branches on this exit status, so an unresolved CLI would read as "stop" or
# "discharge" depending on the pipe's last status — a resolution gap deciding a merge gate.
# Refuse first (§CLI: could-not-run is UNKNOWN, never a discharge; #3314).
[ -x "$PCLI" ] || { echo "ship-it: cp-cardinality is UNRESOLVED at '$PCLI' — the §CP discharge is UNKNOWN, NOT discharged. STOP." >&2; exit 1; }
if printf '%s\n' "$MEMBERS" | "$PCLI" cp-cardinality decide \
     --author "$AUTHOR" \
     $([ "$NON_AUTHOR_APPROVAL_AT_HEAD" = true ] && printf -- '--non-author-approval-at-head') \
     $([ "$SELF_APPROVAL_AT_HEAD" = true ] && printf -- '--self-approval-at-head'); then
  echo "§CP approval: discharged deterministically (ADR 0175) → carry on to machine gates"
else
  # Reachable ONLY with every input proven readable, so this message states a fact: the branch's
  # required human signal is genuinely absent.
  echo "§CP approval: STOP (awaiting control-plane approval) — cardinality branch not satisfied (ADR 0175)"
fi
