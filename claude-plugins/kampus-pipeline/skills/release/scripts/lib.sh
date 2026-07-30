#!/usr/bin/env bash
# release-only helpers. Sourced, never executed: it defines functions and sets no shell options, so
# the sourcing script keeps its own `set -uo pipefail`. This lives HERE and not in
# ../../shared/lib/common.sh because only this skill needs it — anka-ops is the flag lever, and no
# other skill touches it.

# Absolute path to the anka-ops package. The moved blocks all opened with a bare
# `cd packages/anka-ops`, which silently resolves against whatever cwd the caller happened to have;
# resolving it from the repo root instead makes the scripts cwd-independent, and a missing package
# fails closed rather than running `node src/bin.ts` in the wrong tree.
release_anka_ops_dir() {
	local root dir
	root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
		printf 'release: not inside a git repository — cannot locate packages/anka-ops.\n' >&2
		return 1
	}
	dir="$root/packages/anka-ops"
	if [ ! -d "$dir" ]; then
		printf 'release: %s does not exist — the flag lever is unavailable in this checkout.\n' "$dir" >&2
		return 1
	fi
	printf '%s\n' "$dir"
}
