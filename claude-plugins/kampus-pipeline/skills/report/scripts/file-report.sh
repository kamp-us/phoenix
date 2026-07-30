#!/usr/bin/env bash
# File the report: read the composed five-section body on STDIN, append a blank line + the metadata
# footer, and stream the whole thing into `tracker create-issue` (which enters the needs-triage queue
# by default, ADR 0190). Also the emit path wayfinder's epic-emission uses.
#
# usage: <composed body on stdin> | file-report.sh <title>
#
# STDIN, not a file path, and not a `--body` argument: there is no named temp file to collide on and
# no shared variable to reuse stale, so two concurrent runs cannot interleave bodies (#2002, §SP's
# "prefer no file at all"). The body is held only in this process's own local `$BODY` — nothing
# shared, nothing reused across creates — which is what lets the emptiness check below exist without
# reintroducing that hazard.
#
# An EMPTY stdin is REFUSED. Moving the body from a literal heredoc to a pipe made stdin an external
# input, and an unread pipe is byte-identical to an empty one — filing on it would post a bodyless
# issue that looks like a successful report (#3924's class, ruled fail-closed).
#
# Extracted from report/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: <body on stdin> | file-report.sh <title>" >&2; exit 2; }
TITLE="$1"
[ -n "$TITLE" ] || { echo "file-report: empty title — refusing to file an untitled report." >&2; exit 2; }
PCLI="$(kp_pcli)" || exit 127
# shellcheck disable=SC1007  # `CDPATH= cd` clears CDPATH for the subshell — the same idiom the lib source line uses
FOOTER="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)/footer.sh"
[ -x "$FOOTER" ] || { echo "file-report: $FOOTER is not executable — refusing to file a footerless report." >&2; exit 1; }

BODY="$(cat)"
[ -n "$BODY" ] || { echo "file-report: EMPTY body on stdin — refusing to file a bodyless issue (#3924)." >&2; exit 2; }

{
  printf '%s\n' "$BODY"
  echo        # blank line before the footer block
  "$FOOTER"   # emits its own `---` + <sub>… line
} | "$PCLI" tracker create-issue --title "$TITLE"
