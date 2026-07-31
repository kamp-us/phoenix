# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/bin/pipeline-cli"
# doc/vocab-surface-only? exit 0 = yes (issueless is legitimate), non-zero = no (hard-stop below).
# Predicate single-sourced in §CLASS (DOC_VOCAB_EXCLUDE_RE / DOC_VOCAB_SURFACE_RE); fails closed to
# "no" on an unreadable source or zero input (ADR 0092) — it can only ever REFUSE the allowance.
gh api --paginate "repos/$REPO/pulls/$PR/files?per_page=100" --jq '.[].filename' \
  | "$PCLI" class-probe doc-vocab-surface-only
