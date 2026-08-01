#!/usr/bin/env bash
# PreToolUse belt for the `.claude/.pipeline` link (#4605): plant it into the tree the tool is about
# to run in, before that tool runs.
#
# WHY A THIRD PLANTING SITE EXISTS, since two hooks were supposed to be enough. SessionStart covers
# the session's own project dir and WorktreeCreate covers a worktree — but WorktreeCreate is INERT on
# the harness path that actually provisions `isolation:worktree` agent trees (#4180: the harness takes
# the hook only when its own predicate says so, and otherwise provisions internally; this host's
# invocation trace is empty). A worktree lane is the pipeline's normal shape, so relying on that hook
# alone would leave the majority of lanes with no link and every fence at exit 127.
#
# PreToolUse is the one surface that demonstrably fires in a worktree-isolated subagent, and it fires
# BEFORE the tool call — which is what turns "the link exists before the first skill invocation" from
# a hope into an ordering property. Planting is idempotent (a correct link is left untouched), so the
# repeat cost is a readlink.
#
# Contract: reads the PreToolUse JSON payload on stdin for `cwd`. ALWAYS exits 0 — a PreToolUse hook
# that exits 0 with no stdout is an implicit allow, so this can never block a tool call, and a
# planting failure is left to surface where it is actionable (the fence's own 127, which the corpus
# treats as UNKNOWN and never as a negative answer).
set -uo pipefail

HOOKS_DIR="$(dirname -- "${BASH_SOURCE[0]}")"
payload="$(cat 2>/dev/null)" || payload=""

# jq when available, else the flat `"key": "value"` fallback — the same shape create-worktree.sh
# uses, for the same reason: a hook may fire before the toolchain is warm.
cwd=""
if [ -n "$payload" ]; then
	if command -v jq >/dev/null 2>&1; then
		cwd="$(printf '%s' "$payload" | jq -r '.cwd // empty' 2>/dev/null)"
	else
		cwd="$(printf '%s' "$payload" \
			| grep -o '"cwd"[[:space:]]*:[[:space:]]*"[^"]*"' \
			| head -n1 \
			| sed -E 's/.*"cwd"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')"
	fi
fi

# Both trees, because they differ exactly when it matters: an isolated subagent's `cwd` is its
# worktree while `CLAUDE_PROJECT_DIR` stays the primary checkout, and each needs its own link (a
# worktree is a separate working tree with its own `.claude/`). When they coincide the second call is
# the idempotent no-op.
for tree in "$cwd" "${CLAUDE_PROJECT_DIR:-}"; do
	[ -n "$tree" ] || continue
	[ -d "$tree" ] || continue
	bash "$HOOKS_DIR/plant-pipeline-link.sh" "$tree" >/dev/null 2>/dev/null || true
done

exit 0
