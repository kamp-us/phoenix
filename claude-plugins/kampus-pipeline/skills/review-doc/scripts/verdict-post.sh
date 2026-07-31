# resolve the verdict CLI via the `bin/pipeline-cli` shim — in-repo bin, else the installed bin,
# else the pinned `pnpm dlx` fallback reading the one pin (hooks/pin.sh); no version pinned here
# (#3653; ADR 0062/0064; epic #994)
VERDICT="${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/bin/pipeline-cli verdict"

VERDICT_FILE="$(mktemp /tmp/review-doc-verdict.XXXXXX)"
# write your composed PASS verdict into "$VERDICT_FILE" (first line: review-doc: PASS @ <HEAD_SHA> — merge-ready)
$VERDICT post --pr "$PR" --gate doc --body-file "$VERDICT_FILE"   # upsert (PATCH own prior marker, else POST)
