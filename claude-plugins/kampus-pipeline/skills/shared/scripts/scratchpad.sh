#!/usr/bin/env bash
# §SP — the per-run scratchpad allocation, extracted from `gh-issue-intake-formats.md` (epic #4435
# phase 1, #4450). The *why* — the exclusive-create owner stamp, the open-once/re-derive-freely
# distinction, and why there is NO fallback to a shared location — stays in that contract's §SP prose
# (#3718, #4028, ADR 0092).
#
# MECHANICAL MOVE. Every moved line is byte-identical to the fence it came from, with the prose
# metavariables bound to positional parameters in the no-CLI fallback (`<slug>` -> "$1",
# `<file>` -> "$2"). Verbification is phase 2 (#1929, ADR 0228). Do not "improve" it here.
#
# DUAL-MODE (ADR 0232) — the why is `.patterns/skill-script-shell-shape.md` § The dual-mode shape.
#   EXECUTED:  bash ./claude-plugins/kampus-pipeline/skills/shared/scripts/scratchpad.sh \
#                   <verb|open-fallback|path-fallback> <slug> [<leaf-file>]
#              stdout ⇒ `RUN_SCRATCH=<dir>`, plus `VERDICT=<file>` for the `verb` form — the same
#              values the sourced form left in the caller's shell. Nothing on stdout on failure.
#   SOURCED:   no in-script consumer today; the three functions stay for one.
# No EXIT trap: under bash 3.2 a cleanup trap's last command becomes the
# script's status, which would launder a `set -u` abort — or the fail-closed session-id refusal below
# — into exit 0 (#4476, class #4479).
#
# Note what §SP itself says about the fallback and now no longer applies the same way: the one-liner
# was "deliberately inlined at each site rather than made a shell helper, since a helper is itself
# shell state that doesn't survive between Bash calls." A SOURCED script is not shell state — it is a
# file on disk — so the fallback is a function here. That is the extraction's whole point (#4435), not
# a change to the recipe, which is byte-identical below.

if [ "${BASH_SOURCE[0]}" = "$0" ]; then set -uo pipefail; fi   # executed mode only (ADR 0232)

# --- The verb: allocation is owned by one tested verb, so a caller cites it ------------------------
# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/bin/pipeline-cli"

kp_sp_verb() {   # $1 = slug (e.g. review-doc-$PR), $2 = leaf file name for the `file` sub-read
# OPEN — the run's first write of scratch state. Claims the namespace exclusively and stamps it
# as ours, clearing whatever an unclaimed earlier occupant left behind.
RUN_SCRATCH="$("$PCLI" scratchpad open --slug "$1")" || return 1

# RE-DERIVE — every LATER Bash call, where shell state is already gone. Asserts the namespace
# exists AND is still ours; it never creates one, because answering "you never opened it" with a
# fresh empty directory is how a read of your own state silently becomes a read of nothing.
RUN_SCRATCH="$("$PCLI" scratchpad path --slug "$1")" || return 1
VERDICT="$("$PCLI" scratchpad file --slug "$1" --name "$2")" || return 1
}

# --- The no-CLI fallback (a foreign install, ADR 0062) --------------------------------------------
kp_sp_open_fallback() {   # $1 = slug
# OPEN — the skill's first step that writes state. Fail closed on a missing session id: never
# fall back to a shared path, since a fallback resurrects the exact clobber (ADR 0092). The
# `rm -rf` clears leftovers from an EARLIER run of this same slug in this same session, so a
# re-run never reads its predecessor's files.
[ -n "${CLAUDE_CODE_SESSION_ID:-}" ] || {
  echo "§SP: CLAUDE_CODE_SESSION_ID unset — refusing to write run state to a shared scratch path (#3718)." >&2; return 1; }
RUN_SCRATCH="${TMPDIR:-/tmp}/kampus-run/$CLAUDE_CODE_SESSION_ID/$1"
rm -rf "$RUN_SCRATCH" && mkdir -p "$RUN_SCRATCH" || {
  echo "§SP: could not create the per-run scratch dir $RUN_SCRATCH." >&2; return 1; }
}

kp_sp_path_fallback() {   # $1 = slug, $2 = leaf file name whose survival is asserted
# RE-DERIVE — every LATER Bash call. Same recipe ⇒ same directory ⇒ the files are still there.
# NO `rm -rf` here: that is the open step's job, and repeating it would delete the very state
# this call came to read. Assert what you expect to find, rather than reading a silent absence.
RUN_SCRATCH="${TMPDIR:-/tmp}/kampus-run/${CLAUDE_CODE_SESSION_ID:?§SP: session id unset (#3718)}/$1"
[ -s "$RUN_SCRATCH/$2" ] || { echo "§SP: $RUN_SCRATCH/$2 did not survive — re-run the opening step in THIS session." >&2; return 1; }
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1-}" in
    verb)
      kp_sp_verb "${2:?scratchpad.sh verb: no slug}" "${3:?scratchpad.sh verb: no leaf file name}" || exit 1
      printf 'RUN_SCRATCH=%s\n' "$RUN_SCRATCH"
      printf 'VERDICT=%s\n' "$VERDICT"
      ;;
    open-fallback)
      kp_sp_open_fallback "${2:?scratchpad.sh open-fallback: no slug}" || exit 1
      printf 'RUN_SCRATCH=%s\n' "$RUN_SCRATCH"
      ;;
    path-fallback)
      kp_sp_path_fallback "${2:?scratchpad.sh path-fallback: no slug}" "${3:?scratchpad.sh path-fallback: no leaf file name}" || exit 1
      printf 'RUN_SCRATCH=%s\n' "$RUN_SCRATCH"
      ;;
    *) echo "usage: scratchpad.sh <verb|open-fallback|path-fallback> <slug> [<leaf-file>]" >&2; exit 2 ;;
  esac
fi
