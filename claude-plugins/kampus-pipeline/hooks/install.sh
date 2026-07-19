#!/usr/bin/env bash
# SessionStart: install @kampus/pipeline-cli into the pipeline data dir once,
# version-aware + idempotent + network-resilient. See ADR 0103 and
# .patterns/plugin-sessionstart-install.md.
#
# Data dir (where the CLI is installed) is resolved by resolve-data-dir.sh, robust
# to Claude Code's verbatim settings.json `env` semantics (see that file / #2495);
# guard.sh sources the SAME resolver so the two stay in lockstep whether invoked by
# the plugin or by phoenix's settings.json.
#
# Invariant: this MUST NOT hard-crash the session. Every failure path degrades
# (logs to stderr, exit 0) so a SessionStart on an offline/npm-unreachable host
# still starts. The guard wrapper (guard.sh) independently fail-opens when the
# CLI is absent (#1050), so a degraded install never aborts a downstream hook.

set -u

# The one version pin (single source: also read by guard.sh's data dir; the
# skills' published-fallback pins must match). Bump to reinstall on next SessionStart.
PIN="0.2.0"
PKG="@kampus/pipeline-cli"

. "$(dirname "${BASH_SOURCE[0]}")/resolve-data-dir.sh"
DATA="$(resolve_pipeline_data_dir)" || {
	echo "kampus-pipeline: no resolvable data dir (env value unexpanded and CLAUDE_PROJECT_DIR unset); skipping install" >&2
	exit 0
}

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
