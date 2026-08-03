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
# treats as UNKNOWN and never as a negative answer). A failure also leaves ONE breadcrumb; see the
# stamp below.
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

# The one breadcrumb a planting failure leaves (#4818) — until now both streams were discarded under
# an unconditional exit 0, so a failure was diagnosable only by archaeology on symlink mtimes.
# It lives OUTSIDE every working tree on purpose: a breadcrumb written into the tree would show up in
# `git status`, and the worktree sweep KEEPS a dirty tree forever (#3943), so the failure report
# would leak the very worktree it reported on.
PLANT_LOG="${TMPDIR:-/tmp}/kampus-pipeline-plant-failures.log"

# Both trees, because they differ exactly when it matters: an isolated subagent's `cwd` is its
# worktree while `CLAUDE_PROJECT_DIR` stays the primary checkout, and each needs its own link (a
# worktree is a separate working tree with its own `.claude/`). When they coincide the second call is
# the idempotent no-op.
for tree in "$cwd" "${CLAUDE_PROJECT_DIR:-}"; do
	[ -n "$tree" ] || continue
	[ -d "$tree" ] || continue
	if ! why="$(bash "$HOOKS_DIR/plant-pipeline-link.sh" "$tree" 2>&1 >/dev/null)"; then
		printf '%s\tplant-link-pretooluse\t%s\t%s\n' \
			"$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$tree" "${why:-no diagnostic}" \
			>>"$PLANT_LOG" 2>/dev/null || true
	fi
done

exit 0
