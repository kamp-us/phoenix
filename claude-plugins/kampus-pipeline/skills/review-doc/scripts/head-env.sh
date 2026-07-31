# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/bin/pipeline-cli"
HEAD_ENV="$("$PCLI" scratchpad file --slug "review-doc-$PR" --name head.env)" || exit 1
[ -s "$HEAD_ENV" ] || { echo "review-doc: §SP — head.env absent/empty; re-run the materialize step in THIS session." >&2; exit 1; }
. "$HEAD_ENV"                        # $PR_REF / $HEAD_SHA (and $REVIEW_WT, if --worktree was used)
