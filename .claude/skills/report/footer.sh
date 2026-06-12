#!/usr/bin/env bash
# Emit the report skill's metadata footer: a single <sub> line of machine/session
# context for the issue body. Best-effort — every field is dropped if absent.
#
# PRIVACY CONTRACT (load-bearing, do not relax):
#   - NO PII: never read git user.email / user.name or any author identity.
#   - NO user-local absolute paths: nothing under /Users, ~, ~/.claude, ~/.usirin.
# Only machine/session context belongs here. If you add a field, it must satisfy both.
set -euo pipefail

parts=("Filed by an agent")

# Session id — Claude Code exposes it in the environment when running.
session="${CLAUDE_CODE_SESSION_ID:-}"
if [[ -n "$session" ]]; then
	parts+=("session \`${session}\`")
fi

# Model — env var if present, else nothing (never guess).
model="${ANTHROPIC_MODEL:-${CLAUDE_MODEL:-}}"
if [[ -n "$model" ]]; then
	parts+=("model \`${model}\`")
fi

# Branch — repo-relative ref name only (a branch name is not a filesystem path).
branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
if [[ -n "$branch" && "$branch" != "HEAD" ]]; then
	parts+=("branch \`${branch}\`")
fi

# Timestamp — always available, UTC ISO-8601.
parts+=("$(date -u +"%Y-%m-%dT%H:%M:%SZ")")

# Join with " · ".
line=""
for p in "${parts[@]}"; do
	if [[ -z "$line" ]]; then line="$p"; else line="$line · $p"; fi
done

printf -- '---\n<sub>%s</sub>\n' "$line"
