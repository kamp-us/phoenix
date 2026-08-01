#!/usr/bin/env bash
# Plant `<tree>/.claude/.pipeline` -> the live plugin install, so a skill fence can name the
# pipeline by a LITERAL relative path that resolves in ANY consuming repo — not just in a phoenix
# checkout (#4605).
#
# The forcing constraint: the harness's isolation verifier is a SYNTACTIC check on the command
# string, so a fence may carry no expansion at all — not `$CLAUDE_PLUGIN_ROOT`, not `${VAR:-default}`,
# not `$(…)` (ADR 0235). The only shape that runs is a plain literal path, and the only literal that
# is true in every repo is one the consuming repo itself provides. A hook is a harness-SUBSTITUTED
# surface (`${CLAUDE_PLUGIN_ROOT}` is expanded into the hook command in hooks.json), so a hook can
# know where the plugin actually lives; a top-level agent Bash command cannot. This script is that
# bridge, and the link is the whole remedy: one symlink, no copied tree, nothing that can go stale.
#
# Usage:  bash plant-pipeline-link.sh <tree-root>
#   <tree-root>  the working tree to plant into (the repo root, or a linked worktree's root).
#
# stdout: the planted link path on success (nothing otherwise). Diagnostics go to stderr.
# exit:   0 planted (or already correct); 1 could not plant.
#
# Callers decide the severity, not this script: `install.sh` (SessionStart) degrades to exit 0
# because a SessionStart hook must never hard-crash a session, while `create-worktree.sh` is free to
# treat a failure as it treats every other provisioning failure. Keeping the severity at the call
# site is why this file only ever reports.
set -uo pipefail

TREE="${1:-}"
if [ -z "$TREE" ] || [ ! -d "$TREE" ]; then
	echo "plant-pipeline-link: no usable tree root argument — refusing (fail-closed)." >&2
	exit 1
fi

# Resolve the plugin root from THIS FILE's location, never from `$CLAUDE_PLUGIN_ROOT`. The env var is
# not reliably exported into a hook's process (hooks.json interpolates it into the command STRING),
# and phoenix's own settings.json reaches these hooks by `$CLAUDE_PROJECT_DIR` with no such variable
# at all — so the script's own path is the one signal that is true on both paths.
# shellcheck disable=SC1007  # `CDPATH= cd` is the corpus idiom: an empty CDPATH for this one command
HOOKS_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)" || {
	echo "plant-pipeline-link: cannot resolve my own directory — refusing (fail-closed)." >&2
	exit 1
}
# shellcheck disable=SC1007
PLUGIN_ROOT="$(CDPATH= cd -- "$HOOKS_DIR/.." && pwd -P)" || {
	echo "plant-pipeline-link: cannot resolve the plugin root — refusing (fail-closed)." >&2
	exit 1
}
if [ ! -d "$PLUGIN_ROOT/skills" ]; then
	echo "plant-pipeline-link: '$PLUGIN_ROOT' has no skills/ — not a plugin root, refusing (fail-closed)." >&2
	exit 1
fi

# shellcheck disable=SC1007
TREE_ABS="$(CDPATH= cd -- "$TREE" && pwd -P)" || {
	echo "plant-pipeline-link: tree root is not enterable — refusing (fail-closed)." >&2
	exit 1
}

# A repo that VENDORS the plugin (phoenix, and every phoenix worktree) gets a RELATIVE target into
# its own checkout. Two properties fall out that an absolute link would lose: no machine-local path
# is ever written into a tree, and a lane exercises the skills IT has checked out rather than the
# primary's copy — which is the whole point of an isolated worktree when the diff under test IS the
# skill corpus. Every other consumer gets the absolute install path, because there is nothing in
# their tree to point at.
TARGET="$PLUGIN_ROOT"
if [ -d "$TREE_ABS/claude-plugins/kampus-pipeline/skills" ]; then
	TARGET="../claude-plugins/kampus-pipeline"
fi

LINK="$TREE_ABS/.claude/.pipeline"
mkdir -p "$TREE_ABS/.claude" 2>/dev/null || {
	echo "plant-pipeline-link: cannot create '$TREE_ABS/.claude' — refusing (fail-closed)." >&2
	exit 1
}

# Keep the tree CLEAN. A machine-local link that shows up in `git status` is not cosmetic damage:
# the worktree sweep KEEPS a dirty tree forever (#3943), so every lane would leak its worktree — and
# in a consumer's repo we cannot edit their `.gitignore`, which is theirs. `.git/info/exclude` is the
# right surface: per-clone, never committed, and exactly what it is for. Best-effort — a tree we
# cannot ignore into is still a working link.
#
# `git -C "$TREE_ABS"` addresses the tree we were HANDED, never the process cwd and never a path
# derived from this script's own location. That distinction matters here specifically: reached
# through the planted link, a script's `${BASH_SOURCE[0]}` is a logical path that looks in-repo while
# the file physically lives in the install — so anything shelling out to git from such a path
# resolves the wrong repository. Nothing below relies on where this file sits.
COMMON_GIT_DIR="$(git -C "$TREE_ABS" rev-parse --git-common-dir 2>/dev/null)"
case "$COMMON_GIT_DIR" in
	'') : ;;                                   # not a git repo (or git absent) — nothing to exclude into
	/*) : ;;
	*) COMMON_GIT_DIR="$TREE_ABS/$COMMON_GIT_DIR" ;;   # git may answer relative to the tree
esac
if [ -n "$COMMON_GIT_DIR" ] && [ -d "$COMMON_GIT_DIR" ]; then
	EXCLUDE="$COMMON_GIT_DIR/info/exclude"
	if ! grep -qxF '/.claude/.pipeline' "$EXCLUDE" 2>/dev/null; then
		mkdir -p "$COMMON_GIT_DIR/info" 2>/dev/null
		printf '%s\n' '/.claude/.pipeline' >>"$EXCLUDE" 2>/dev/null || true
	fi
fi

# Idempotent: a link already at the intended target is left alone, so a resumed session does not
# churn the tree. Anything else at that path — a stale link, or a real directory from an older
# materialize-the-tree attempt — is replaced, because a WRONG `.pipeline` is worse than none: it
# resolves, so every fence silently runs the wrong corpus instead of failing loudly.
if [ -L "$LINK" ] && [ "$(readlink "$LINK" 2>/dev/null)" = "$TARGET" ]; then
	printf '%s\n' "$LINK"
	exit 0
fi
rm -rf "$LINK" 2>/dev/null

if ! ln -s "$TARGET" "$LINK" 2>/dev/null; then
	echo "plant-pipeline-link: could not link '$LINK' -> '$TARGET' — pipeline fences will exit 127 until this is fixed." >&2
	exit 1
fi

# Prove the link RESOLVES, not merely that `ln` returned 0. A dangling link is exactly the startup
# state this whole remedy has to avoid: a fence through it exits 127, which a caller reading a bare
# exit code can mistake for an ordinary negative answer (#4605 acceptance condition 2).
if [ ! -d "$LINK/skills" ]; then
	echo "plant-pipeline-link: planted '$LINK' -> '$TARGET' but it does not resolve to a plugin (DANGLING)." >&2
	exit 1
fi

echo "plant-pipeline-link: $LINK -> $TARGET" >&2
printf '%s\n' "$LINK"
