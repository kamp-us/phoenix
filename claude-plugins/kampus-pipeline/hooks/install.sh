#!/usr/bin/env bash
# SessionStart: install @kampus/pipeline-cli into the pipeline data dir once,
# version-aware + idempotent + network-resilient. See ADR 0103 and
# .patterns/plugin-sessionstart-install.md.
#
# Data dir (where the CLI is installed) is resolved from, in order:
#   1. $KAMPUS_PIPELINE_DATA  — phoenix's .claude/settings.json self-wiring (#1003)
#   2. $CLAUDE_PLUGIN_DATA    — the foreign-repo plugin surface (hooks.json)
# guard.sh resolves the CLI from the SAME dir via the same precedence, so the two
# stay in lockstep whether invoked by the plugin or by phoenix's settings.json.
#
# Invariant: this MUST NOT hard-crash the session. Every failure path degrades
# (logs to stderr, exit 0) so a SessionStart on an offline/npm-unreachable host
# still starts. The guard wrapper (guard.sh) independently fail-opens when the
# CLI is absent (#1050), so a degraded install never aborts a downstream hook.

set -u

# The one version pin (single source: also read by guard.sh's data dir; the
# skills' published-fallback pins must match). Bump to reinstall on next SessionStart.
PIN="0.1.0"
PKG="@kampus/pipeline-cli"

DATA="${KAMPUS_PIPELINE_DATA:-${CLAUDE_PLUGIN_DATA:-}}"
if [ -z "$DATA" ]; then
	echo "kampus-pipeline: no data dir (KAMPUS_PIPELINE_DATA / CLAUDE_PLUGIN_DATA unset); skipping install" >&2
	exit 0
fi

MARKER="$DATA/.pipeline-cli.version"
BIN="$DATA/node_modules/.bin/pipeline-cli"

# Version-aware idempotency: the marker holds the version last installed here.
# Reinstall only when the marker is missing, mismatched, or the bin vanished.
if [ -x "$BIN" ] && [ -f "$MARKER" ] && [ "$(cat "$MARKER" 2>/dev/null)" = "$PIN" ]; then
	exit 0
fi

mkdir -p "$DATA" 2>/dev/null || {
	echo "kampus-pipeline: cannot create $DATA; skipping install" >&2
	exit 0
}

# A minimal package.json so npm installs into $DATA/node_modules deterministically.
cat >"$DATA/package.json" <<JSON
{
	"name": "kampus-pipeline-data",
	"private": true,
	"dependencies": { "$PKG": "$PIN" }
}
JSON

# Prefer npm (always present where node is). --no-audit/--no-fund keep it quiet;
# the whole thing is best-effort — any failure degrades to exit 0 below.
if (cd "$DATA" && npm install --no-audit --no-fund --loglevel=error >/dev/null 2>&1) && [ -x "$BIN" ]; then
	printf '%s' "$PIN" >"$MARKER"
	echo "kampus-pipeline: installed $PKG@$PIN into $DATA" >&2
	exit 0
fi

# Install failed (offline, npm-unreachable, registry error). Drop the marker so
# the next SessionStart retries; never abort the session.
rm -f "$MARKER" 2>/dev/null
echo "kampus-pipeline: install of $PKG@$PIN failed (offline?); guards fail-open until next session" >&2
exit 0
