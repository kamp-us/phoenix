# resolve the verdict CLI via the `bin/pipeline-cli` shim — in-repo bin, else the installed bin,
# else the pinned `pnpm dlx` fallback reading the one pin (hooks/pin.sh); no version pinned here (#3653).
VERDICT="${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/bin/pipeline-cli verdict"
VERDICT_FILE="$(mktemp /tmp/review-skill-verdict.XXXXXX)"
# write your composed PASS verdict into "$VERDICT_FILE" (first line: review-skill: PASS @ <HEAD_SHA> — merge-ready)
# Upsert through the guarded tool on the (PR, gate-namespace, head, run) key: it replaces this
# head+run's own review-skill record (namespace-anchored, so a blocking↔non-blocking flip replaces
# a prior advisory at the same key too) and appends against any other key, and it
# fail-closes on a malformed/cross-namespace body — the mktemp-path `@ <sha>` leak (#2683) never lands.
$VERDICT post --pr "$PR" --gate skill --body-file "$VERDICT_FILE"
