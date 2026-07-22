#!/usr/bin/env bash
# Version-gated, fail-open dispatch wrapper for the guard hooks.
#
# Usage: guard.sh <tool> [mode...]   e.g. guard.sh worktree-guard pre-file
#                                         guard.sh worktree-guard pre-bash
#                                         guard.sh spawn-guard guard
#                                         guard.sh spawn-guard freshness
#
# Resolves the SessionStart-installed pipeline-cli from the pipeline data dir
# (via resolve-data-dir.sh — the same resolver install.sh uses, robust to verbatim
# settings.json `env` values; see that file / #2495) and dispatches
# `pipeline-cli <tool> [mode...]`, forwarding the hook's stdin.
#
# READINESS IS A VERSION CHECK, NOT AN EXECUTABILITY CHECK (#3742). This wrapper used to
# dispatch on `[ -x "$BIN" ]`, which cannot distinguish the pinned build from a months-old
# one left on disk by a failed install. Because 0.2.0 was never published, every SessionStart
# install failed and every guard hook kept exec'ing the stale 0.1.0 tree — a build predating
# ADR 0172 with zero copies of the isolation guard. Nothing was logged, so the isolation
# defense read as armed while enforcing nothing. The readiness test is now `installed == pin`
# (pin.sh vs the marker install.sh writes only after a verified install), so a build this
# wrapper cannot prove is the pinned one is NEVER dispatched. An unpublished pin is
# indistinguishable from a failed install by construction, which is why the same test covers
# both.
#
# #1050 FAIL-OPEN INVARIANT (HARD): a refusal to dispatch still exits 0. When the CLI is
# absent — not yet installed, a degraded/offline install, or a worktree-creation hook firing
# with a stripped PATH before SessionStart completes — this MUST no-op (consume stdin, exit
# 0), never abort the hook/spawn. A PreToolUse hook that exits 0 with no stdout is an
# implicit allow, so a fail-open is a transparent no-op. This is the only thing standing
# between a not-yet-installed CLI and an all-lanes spawn abort (#787/#788/#789 incident class
# via the shared .git/hooks). Whether a guard should instead fail CLOSED on a proven-unsafe
# state is an open founder ruling — #3743; this wrapper does not pre-empt it. What #3742
# changes is only WHICH BUILD may run: a stale one is refused loudly instead of dispatched
# silently.

set -u

HOOKS_DIR="$(dirname "${BASH_SOURCE[0]}")"
. "$HOOKS_DIR/resolve-data-dir.sh"
. "$HOOKS_DIR/pin.sh"   # KAMPUS_PIPELINE_CLI_PIN / _PKG — the one pin, shared with install.sh

DATA="$(resolve_pipeline_data_dir || true)"
BIN="${DATA:+$DATA/node_modules/.bin/pipeline-cli}"

# Drain the hook's stdin and exit 0 — the implicit-allow no-op every refusal path takes.
no_dispatch() {
	cat >/dev/null 2>&1 || true
	exit 0
}

# FAIL-OPEN: CLI not resolvable -> no-op. Silent by design; a not-yet-installed CLI is the
# expected state on a cold consumer, not a fault worth a line on every tool call.
if [ -z "$DATA" ] || [ ! -x "$BIN" ]; then
	no_dispatch
fi

# The marker is install.sh's attestation of the version it verifiably installed here: it is
# written only after the install succeeded AND the bin was executable, and dropped on any
# failure. So marker != pin means the tree on disk is not the pinned build, whether it is
# stale, partial, or from a pin that does not exist on npm.
INSTALLED="$(cat "$DATA/.pipeline-cli.version" 2>/dev/null)"
if [ "$INSTALLED" != "$KAMPUS_PIPELINE_CLI_PIN" ]; then
	# One warning per drift state per session. install.sh clears this stamp at every
	# SessionStart, so the refusal is loud once and then quiet — the pre-file hook fires on
	# every Read/Edit/Write, and a per-call warning would drown the transcript it must be
	# noticed in.
	STAMP="$DATA/.pipeline-cli.stale-warned"
	if [ "$(cat "$STAMP" 2>/dev/null)" != "$KAMPUS_PIPELINE_CLI_PIN:$INSTALLED" ]; then
		echo "kampus-pipeline: REFUSING to dispatch \`$*\` — installed '${INSTALLED:-none}' != pinned '$KAMPUS_PIPELINE_CLI_PIN' in $DATA." >&2
		echo "kampus-pipeline: the pinned build is not installed, so the tree on disk would under-enforce silently. ALL guards are INERT until a matching version installs — treat concurrent agent lanes as unguarded." >&2
		echo "kampus-pipeline: remedy — publish ${KAMPUS_PIPELINE_CLI_PKG}@${KAMPUS_PIPELINE_CLI_PIN} (cut a \`pipeline-cli-v${KAMPUS_PIPELINE_CLI_PIN}\` GitHub Release), then restart the session. See #3742." >&2
		printf '%s' "$KAMPUS_PIPELINE_CLI_PIN:$INSTALLED" 2>/dev/null >"$STAMP" || true
	fi
	no_dispatch
fi

# Pinned build confirmed: dispatch. exec replaces this shell so the CLI owns stdin/stdout
# and its exit code (a real guard verdict — block/allow) is the hook's verdict.
exec "$BIN" "$@"
