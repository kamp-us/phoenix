#!/usr/bin/env bash
# Step R2's additive fold-in: the still-anchored, in-scope inline review comments.
#
# usage: stepR2-inline-comments.sh <PR>
#
# stdout IS the additive fix list — one `{id, path, line, body}` object per in-scope comment. An empty
# list is a real answer (no in-scope, still-anchored comment); a read that could not run refuses with
# NOTHING on stdout.
#
# Executed, never sourced (ADR 0232). It used to read the `$authorized` set and `$PR` R1 left in the
# agent's shell and leave `$ME` + `$inlineComments` behind; it now reads R1's author set out of the
# §SP scratch dir R1 wrote, and `$ME` is internal. An absent author set is UNKNOWN — R1 never ran
# here — and refuses, never resolves to "no authorized reviewer".
# shellcheck disable=SC1007,SC1091,SC2016
set -uo pipefail
# shellcheck source=../../../lib/common.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

PR="${1:-}"
if [ -z "$PR" ]; then
	printf 'write-code Step R2: no PR number — run this as `bash ./claude-plugins/kampus-pipeline/skills/write-code/scripts/stepR2-inline-comments.sh <PR>`. NO inline comments were folded in.\n' >&2
	exit 1
fi
REPO="$(kp_repo)" || { echo "write-code Step R2: target repo unresolved — NO inline comments were folded in." >&2; exit 1; }
if [ -z "${CLAUDE_CODE_SESSION_ID:-}" ]; then
	echo "write-code Step R2: §SP session id unset — cannot re-derive R1's scratch dir (#3718)." >&2
	exit 1
fi
AUTHORIZED_FILE="${TMPDIR:-/tmp}/kampus-run/$CLAUDE_CODE_SESSION_ID/write-code-repair-$PR/authorized.json"
if [ ! -s "$AUTHORIZED_FILE" ]; then
	echo "write-code Step R2: no R1 author set at $AUTHORIZED_FILE — Step R1 never ran in this session. UNKNOWN, never 'no authorized reviewer'." >&2
	exit 1
fi
authorized="$(cat "$AUTHORIZED_FILE")"

ME=$(gh api user --jq '.login') || { echo "write-code Step R2: could not resolve my own login — NO inline comments were folded in." >&2; exit 1; }
# fetch into a var, then pipe to standalone jq — gh's --jq takes no --argjson, and this reuses
# the same $authorized set R1 already built (same pattern as the marker work-list above)
inlineComments=$(gh api "repos/$REPO/pulls/$PR/comments?per_page=100") \
	|| { echo "write-code Step R2: could not read the inline review comments — UNKNOWN, never 'none'." >&2; exit 1; }
# in-scope, still-anchored inline review comments → your additive fix list (id+path+line+body)
jq --argjson authorized "$authorized" --arg me "$ME" \
	'[ .[]
     | select(.line != null)                                  # non-null line ⇒ still anchored to current head (ADR 0058)
     | select(.user.login != $me)                             # skip self-authored thread replies
     | select((.user.login | IN($authorized[]))               # write+ collaborator (ADR 0055), or…
              or .user.login == "copilot-pull-request-reviewer[bot]")  # …the explicitly-included review bot (#383)
   ] | .[] | {id, path, line, body}' <<<"$inlineComments"
