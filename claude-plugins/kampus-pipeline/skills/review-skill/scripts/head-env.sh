WT_FILE="${TMPDIR:-/tmp}/kampus-run/${CLAUDE_CODE_SESSION_ID:?§SP: session id unset (#3718)}/review-skill-$PR/wt.env"
[ -s "$WT_FILE" ] || { echo "review-skill: §SP — $WT_FILE missing; re-run the head-materialization step in THIS session." >&2; exit 1; }
. "$WT_FILE"
