   # §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
   PCLI="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/bin/pipeline-cli"
   # added lines only ('+'), scanned by the shared matcher: exit 0 = clean, 2 = leak found
   # any OTHER non-zero (4 = the fail-closed stdin read, #4010) is an UNRESOLVED scan, never a pass
   gh pr diff "$PR" | grep '^+' | "$PCLI" leak-guard scan-comment
