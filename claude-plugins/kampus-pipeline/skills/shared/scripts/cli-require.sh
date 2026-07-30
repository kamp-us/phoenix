#!/usr/bin/env bash
# §CLI — the gate-critical shim refusal, extracted from `gh-issue-intake-formats.md` (epic #4435
# phase 1, #4450). The *why* — the whole exit-code taxonomy, and why a 127 is a resolution gap and
# never worktree teardown — stays in that contract's §CLI prose; the message text travelled with the
# shell.
#
# MECHANICAL MOVE. The moved lines are byte-identical to the fence they came from and sit at column 0.
# Verbification is phase 2 (#1929, ADR 0228). Do not "improve" it here.
#
# SOURCE it (`. cli-require.sh`) from a gate-critical block, after §CLI's `PCLI=` preamble has run —
# the fence's `exit 127` becomes a `return 127` when sourced, so the caller decides whether an
# unresolved CLI ends the run or is routed up; either way it is UNKNOWN, never a verdict. Sets no
# shell options and installs no EXIT trap: under bash 3.2 a cleanup trap's last command becomes the
# script's exit status, which would launder this very refusal into exit 0 (#4476, class #4479).

: "${PCLI?cli-require.sh: \$PCLI unset — run the §CLI preamble first; an unresolved shim is UNKNOWN, never a verdict}"

[ -x "$PCLI" ] || {
  echo "pipeline-cli: UNRESOLVED at '$PCLI' — the CLI never ran, so this gate has NO result." >&2
  echo "  Resolve to UNKNOWN, never to clean/negative (§WL: a read that could not run is not an answer)." >&2
  echo "  This is a resolution gap, NOT worktree teardown (teardown = exit 1 ENOENT on a tracked file, then exit 126)." >&2
  return 127 2>/dev/null || exit 127
}
