#!/usr/bin/env bash
# §CP — the classification entry point (#4161), extracted from `gh-issue-intake-formats.md`
# (epic #4435 phase 1, #4450). The *why* — why a path-only "no path matched" is not a verdict, and
# the four-state table — stays in that contract's "A path-only §CP answer is NEVER authoritative"
# prose; the comments below travelled with the shell.
#
# MECHANICAL MOVE. Every moved line sits at column 0, byte-identical to the fence it came from, so a
# reviewer can diff it against the deleted block directly. New since the move: the argument +
# sourcing seam in this header block, and the §ZS scope line below (#4510). Verbification is phase 2
# (#1929, ADR 0228). Do not otherwise "improve" it here.
#
# DUAL-MODE (ADR 0232) — the why is `.patterns/skill-script-shell-shape.md` § The dual-mode shape.
#   EXECUTED:  bash ./claude-plugins/kampus-pipeline/skills/shared/scripts/cp-classify-entry.sh <REPO> <PR>
#              stdout is a PROSE answer channel: the §CP scope line, then `CP_STATE=<state>`, then a
#              `BLOCKING (…)` line on every state but `not-control-plane`. Read the scope line as the
#              evidence the run happened — the ordinary answer here is the ABSENCE of a BLOCKING
#              line, so emptiness must never be read as "ordinary".
#   SOURCED:   no in-script consumer today; the $CP_STATE the body leaves in the caller's shell stays
#              available for one.
# No EXIT trap — under bash 3.2 a cleanup trap's last command becomes the script's exit status,
# laundering a `set -u` abort into exit 0 (#4476, class #4479).

if [ "${BASH_SOURCE[0]}" = "$0" ]; then set -uo pipefail; fi   # executed mode only (ADR 0232)

REPO="${REPO:-${1:?cp-classify-entry.sh: REPO unset and no \$1 — refusing to classify an unnamed repo}}"
PR="${PR:-${2:?cp-classify-entry.sh: PR unset and no \$2 — refusing to classify an unnamed PR}}"
# §CPREAD owns cp_changed_files; the fence assumed the reader had already pasted it into the shell.
# shellcheck source=cp-read.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/cp-read.sh"

# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/bin/pipeline-cli"
# The §CP classification entry point — four states on stdout (#4161). Re-resolves the live
# CONTROL_PLANE_RE from origin/main itself (#981); pass --control-plane-re to reuse one you
# already resolved. ASSERT ON THE STATE WORD, never on the exit status alone — see below.
# The INPUT comes from §CPREAD, never from a bare `gh api … |` pipe: with pipefail off, a failed
# read pipes its stdout ERROR BODY into the verb, which sees one non-`.decisions/` "path", matches
# no §CP clause, and answers `not-control-plane` — a fail-open at the very entry point that exists
# to prevent one (#4216).
if ! cp_changed_files "$REPO" "$PR"; then
  CP_STATE=unknown   # §CPREAD: the input never arrived ⇒ UNKNOWN ⇒ hold as §CP
else
  CP_STATE="$(printf '%s\n' "$CP_FILES" | "$PCLI" cp-classify classify --repo "$REPO")"
fi
# §ZS #1 on the answer channel: the ordinary answer here is the ABSENCE of a `BLOCKING (…)` line, so
# this line is what tells "ran and found nothing" from "never ran". `cp_changed_files` writes only to
# stderr now, so without it stdout would be 0 bytes on the ordinary path
# (`.patterns/skill-script-io-contract.md`, #4510).
echo "§CP scope: PR #$PR — ${CP_FILES_N:-0} file(s) scanned, state '$CP_STATE'"
printf 'CP_STATE=%s\n' "$CP_STATE"   # the positive token, so the executed reader never infers the state from an absence
if [ "$CP_STATE" = "not-control-plane" ]; then
  : # proven ordinary — the ONLY branch that may skip the §CP hold
else
  echo "BLOCKING (§CP state '$CP_STATE')"   # every other value, INCLUDING the empty string a failed invocation yields
fi
