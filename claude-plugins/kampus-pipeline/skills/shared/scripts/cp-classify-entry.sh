#!/usr/bin/env bash
# §CP — the classification entry point (#4161), extracted from `gh-issue-intake-formats.md`
# (epic #4435 phase 1, #4450). The *why* — why a path-only "no path matched" is not a verdict, and
# the four-state table — stays in that contract's "A path-only §CP answer is NEVER authoritative"
# prose; the comments below travelled with the shell.
#
# MECHANICAL MOVE. Every moved line sits at column 0, byte-identical to the fence it came from, so a
# reviewer can diff it against the deleted block directly. Only the argument + sourcing seam in this
# header block is new. Verbification is phase 2 (#1929, ADR 0228). Do not "improve" it here.
#
# SOURCE it (`. cp-classify-entry.sh`) with REPO and PR set: the point of the recipe is the $CP_STATE
# it leaves in the caller's shell. It sets no shell options and installs no EXIT trap — under bash
# 3.2 a cleanup trap's last command becomes the script's exit status, laundering a `set -u` abort
# into exit 0 (#4476, class #4479).

REPO="${REPO:-${1:?cp-classify-entry.sh: REPO unset and no \$1 — refusing to classify an unnamed repo}}"
PR="${PR:-${2:?cp-classify-entry.sh: PR unset and no \$2 — refusing to classify an unnamed PR}}"
# §CPREAD owns cp_changed_files; the fence assumed the reader had already pasted it into the shell.
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
if [ "$CP_STATE" = "not-control-plane" ]; then
  : # proven ordinary — the ONLY branch that may skip the §CP hold
else
  echo "BLOCKING (§CP state '$CP_STATE')"   # every other value, INCLUDING the empty string a failed invocation yields
fi
