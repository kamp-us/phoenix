#!/usr/bin/env bash
# §7 — the claim verbs, extracted from `gh-issue-intake-formats.md` (epic #4435 phase 1, #4450). The
# *why* for each — why layer one is owed by the claim winner on both paths (#4298), why release is
# affirmative and never inferred from age or a session-id mismatch (#4045), why a stale claim is read
# before it is cleared, and why the pre-stamping population is cleared by an audited cleanup rather
# than a resolution rule (#3987) — stays in that contract's §7 prose (ADR 0115/0191).
#
# MECHANICAL MOVE. Each verb invocation below, trailing comment included, is byte-identical to the
# fence line it came from, with the prose metavariables bound to positional parameters (`<N>` -> "$1",
# `<token>` -> "$2"). These ARE the verbs, so there is nothing for phase 2 (#1929) to verbify — ADR
# 0228 keeps them relays: the script passes the verb's answer through, it never re-derives it.
#
# DUAL-MODE (ADR 0232) — the why is `.patterns/skill-script-shell-shape.md` § The dual-mode shape.
#   EXECUTED:  bash ./claude-plugins/kampus-pipeline/skills/shared/scripts/claim-verbs.sh \
#                   <assign|release|status|audit> [<issue>] [<token>|--execute]
#              stdout ⇒ the verb's own stdout, relayed byte-for-byte; the verb's EXIT STATUS is
#              relayed too, because these verbs are default-deny and the status is the whole
#              contract (never swallow it).
#   SOURCED:   no in-script consumer today; the four functions stay for one.
# No EXIT trap — under bash 3.2 a cleanup trap's last command becomes the script's status,
# laundering a `set -u` abort into exit 0 (#4476, class #4479).

if [ "${BASH_SOURCE[0]}" = "$0" ]; then set -uo pipefail; fi   # executed mode only (ADR 0232)

# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/bin/pipeline-cli"

# Layer one — the coarse availability gate, written by whoever won the claim, on BOTH paths (#4298).
kp_claim_assign() {   # $1 = issue number, $2 = delegated token (optional)
if [ -z "${2:-}" ]; then
"$PCLI" claim assign --issue "$1"                    # layer one under our own session
else
"$PCLI" claim assign --issue "$1" --session "$2"  # …or under the threaded delegated token
fi
}

# Release — the claim ends when its run does; affirmative, never inferred.
kp_claim_release() {   # $1 = issue number, $2 = delegated token (optional)
if [ -z "${2:-}" ]; then
"$PCLI" claim release --issue "$1"            # retract our own marker; --session <token> to release a delegated claim
else
"$PCLI" claim release --issue "$1" --session "$2"
fi
}

# Staleness / reclaim — the read-only inventory. Read it BEFORE concluding a lane is stuck.
kp_claim_status() {   # $1 = issue number
"$PCLI" claim status --issue "$1"   # every marker: author, authorization, liveness, and the resolved owner
}

# Pre-stamping markers — the audited cleanup of the one population supersession cannot reach.
kp_claim_audit() {   # $1 = "" for the whole sweep | an issue number | --execute
case "${1:-}" in
'')
"$PCLI" claim audit                 # every open lane held by an unstamped marker, and which are retirable
;;
--execute)
"$PCLI" claim audit --execute       # retire the retirable ones through `claim release`
;;
*)
"$PCLI" claim audit --issue "$1"     # the cheap single-lane read when a stall is already known
;;
esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1-}" in
    assign)  kp_claim_assign  "${2:?claim-verbs.sh assign: no issue number}" "${3-}" ;;
    release) kp_claim_release "${2:?claim-verbs.sh release: no issue number}" "${3-}" ;;
    status)  kp_claim_status  "${2:?claim-verbs.sh status: no issue number}" ;;
    audit)   kp_claim_audit   "${2-}" ;;
    *) echo "usage: claim-verbs.sh <assign|release|status|audit> [<issue>] [<token>|--execute]" >&2; exit 2 ;;
  esac
fi
