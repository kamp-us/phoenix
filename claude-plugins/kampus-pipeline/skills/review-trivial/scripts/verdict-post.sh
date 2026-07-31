NS=code   # or doc / skill, per the class above — the gate namespace is `review-$NS`
HEAD_NOW="$(gh api repos/$REPO/pulls/$PR --jq .head.sha)"
[ "$HEAD_NOW" = "$HEAD_SHA" ] || { echo "head moved under the verdict — re-review the new head or abort (ADR 0058)"; exit 1; }

# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/bin/pipeline-cli"
VERDICT_FILE="$(mktemp /tmp/review-trivial-verdict.XXXXXX)"
# write your composed verdict into "$VERDICT_FILE"; first line is the bare SHA-bound marker:
#   review-<NS>: PASS @ <HEAD_SHA> — merge-ready          (every check passed)
#   review-<NS>: FAIL @ <HEAD_SHA> — not merge-ready       (any check failed)
"$PCLI" verdict post --pr "$PR" --gate "$NS" --body-file "$VERDICT_FILE"
