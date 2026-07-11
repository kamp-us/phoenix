#!/usr/bin/env bash
# Resolve the pipeline data dir — where install.sh drops @kampus/pipeline-cli and
# guard.sh finds it — robust to Claude Code's VERBATIM settings.json `env` semantics.
#
# Claude Code applies `.claude/settings.json` `env` VALUES LITERALLY: it does NOT
# expand ${VAR} inside them (settings docs: `env` = "Environment variables applied
# to every session"; no interpolation is documented, and it's verified empirically
# on BOTH the desktop and web harnesses — #2495). So a wired value such as
# KAMPUS_PIPELINE_DATA="${CLAUDE_PROJECT_DIR}/.claude/.pipeline-cli-data" arrives
# with the token UNEXPANDED. Consuming it verbatim (mkdir -p "$DATA") is exactly
# what created the stray literal `${CLAUDE_PROJECT_DIR}` directory at the repo root.
#
# These scripts run as hook `command`s, and Claude Code DOES export the real
# CLAUDE_PROJECT_DIR / CLAUDE_PLUGIN_DATA env vars onto a hook-spawned process
# (hooks docs) — so we resolve from those, never from an unexpanded env value.
# Precedence: an already-expanded KAMPUS_PIPELINE_DATA / CLAUDE_PLUGIN_DATA, else
# the hook-provided CLAUDE_PROJECT_DIR (phoenix-native path). A value still carrying
# a literal `${` is discarded — never returned, never mkdir'd. Fail-closed: returns
# non-zero (and prints nothing) when nothing resolves to a real, token-free path.
resolve_pipeline_data_dir() {
	local d="${KAMPUS_PIPELINE_DATA:-${CLAUDE_PLUGIN_DATA:-}}"
	case "$d" in *'${'*) d="" ;; esac
	if [ -z "$d" ] && [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
		d="$CLAUDE_PROJECT_DIR/.claude/.pipeline-cli-data"
	fi
	case "$d" in '' | *'${'*) return 1 ;; esac
	printf '%s' "$d"
}
