#!/usr/bin/env bash
# §CLI — the gate-critical shim refusal, extracted from `gh-issue-intake-formats.md` (epic #4435
# phase 1, #4450). The *why* — the whole exit-code taxonomy, and why a 127 is a resolution gap and
# never worktree teardown — stays in that contract's §CLI prose; the message text travelled with the
# shell.
#
# MECHANICAL MOVE. The moved lines are byte-identical to the fence they came from and sit at column 0.
# Verbification is phase 2 (#1929, ADR 0228). Do not "improve" it here.
#
# DUAL-MODE (ADR 0232) — the why is `.patterns/skill-script-shell-shape.md` § The dual-mode shape.
#   EXECUTED:  bash ./claude-plugins/kampus-pipeline/skills/shared/scripts/cli-require.sh <pcli-path>
#              stdout ⇒ one line, `PCLI=<path>`, ONLY when the shim is executable; otherwise nothing
#              on stdout, the three refusal lines on stderr, and exit 127. The path is an ARGUMENT
#              because an executed child cannot see a caller's unexported `$PCLI` — a silent empty
#              read there would refuse every run, which is the wrong kind of fail-closed.
#   SOURCED:   after §CLI's `PCLI=` preamble; the `exit 127` becomes `return 127`, so the caller
#              decides whether an unresolved CLI ends the run or is routed up. Either way it is
#              UNKNOWN, never a verdict.
# No EXIT trap: under bash 3.2 a cleanup trap's last command becomes the script's exit status,
# which would launder this very refusal into exit 0 (#4476, class #4479).

if [ "${BASH_SOURCE[0]}" = "$0" ]; then set -uo pipefail; fi   # executed mode only (ADR 0232)

PCLI="${PCLI-${1-}}"
: "${PCLI?cli-require.sh: \$PCLI unset and no \$1 — run the §CLI preamble first, or pass the shim path; an unresolved shim is UNKNOWN, never a verdict}"

[ -x "$PCLI" ] || {
  echo "pipeline-cli: UNRESOLVED at '$PCLI' — the CLI never ran, so this gate has NO result." >&2
  echo "  Resolve to UNKNOWN, never to clean/negative (§WL: a read that could not run is not an answer)." >&2
  echo "  This is a resolution gap, NOT worktree teardown (teardown = exit 1 ENOENT on a tracked file, then exit 126)." >&2
  return 127 2>/dev/null || exit 127
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  printf 'PCLI=%s\n' "$PCLI"
fi
