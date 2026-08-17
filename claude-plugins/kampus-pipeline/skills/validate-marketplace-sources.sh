#!/usr/bin/env bash
# Every `source` in .claude-plugin/marketplace.json resolves to a real plugin directory.
#
# Nothing else in CI asserts this. The one check that ever did was incidental: invariant 2 of
# validate-gate-path-drift.sh `cd`-ed into the manifest's source while proving a symlink agreed
# with it, and it reached only the FIRST entry (`grep … | head -n1`), so the other plugins were
# never covered. That invariant went with the symlink (ADR 0277, #5276); this guard replaces the
# coverage on its own terms — every entry, no symlink premise (#5605).
#
# A typo'd or renamed `source` otherwise ships a manifest whose plugin simply fails to install,
# with nothing red anywhere. Fails closed on zero entries (ADR 0092): an unparseable manifest is
# never a pass. Run locally or from CI (see .github/workflows/ci.yml).
#
# Bash 3.2 compatible (macOS default shell). Shell shape per
# .patterns/skill-script-shell-shape.md: `set -uo pipefail`, never `-e`, and no `EXIT` trap.
set -uo pipefail

# Self-locating, same idiom as the sibling validators: this script lives in the skills root, three
# levels under the repo root. PHYSICAL resolution (`-P`) so a symlinked or relative caller cannot
# fold `../../..` against the caller's own depth and send the walk past the repo root.
skills_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd -P "$skills_dir/../../.." && pwd -P)"
manifest="$repo_root/.claude-plugin/marketplace.json"

if [ ! -f "$manifest" ]; then
	echo "FAIL: .claude-plugin/marketplace.json not found — nothing to validate (ADR 0092)"
	echo "validate-marketplace-sources: FAILED — 1 error(s)"
	exit 1
fi

# Parse with node rather than grep: the old check's `grep … | head -n1` is exactly why only the
# first entry was ever covered. One `name<TAB>source` line per plugin entry; a malformed manifest
# or a non-string source yields no lines and hits the zero-scope failure below.
# shellcheck disable=SC2016  # the `${…}` below is a JS template literal; shell must not expand it
entries=$(node -e '
	const fs = require("node:fs");
	const mp = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
	for (const p of mp.plugins ?? []) {
		if (typeof p?.source !== "string" || p.source === "") continue;
		process.stdout.write(`${p.name ?? "(unnamed)"}\t${p.source}\n`);
	}
' "$manifest" 2>/dev/null)

if [ -z "$entries" ]; then
	echo "FAIL: no plugin entry with a string \`source\` in .claude-plugin/marketplace.json — a manifest that parses to zero sources is a broken manifest, not a clean scan (ADR 0092)"
	echo "validate-marketplace-sources: FAILED — 1 error(s)"
	exit 1
fi

errors=0
count=0

while IFS="$(printf '\t')" read -r name source; do
	[ -z "$name" ] && continue
	count=$((count + 1))

	# Sources are repo-root-relative (`./claude-plugins/<name>`); an absolute one would resolve
	# against the runner's layout, not the repo, so it is a defect in itself.
	case "$source" in
		/*) echo "FAIL $name: source '$source' is absolute — sources are repo-root-relative"
		    errors=$((errors + 1)); continue ;;
	esac

	dir="$repo_root/$source"
	if [ ! -d "$dir" ]; then
		echo "FAIL $name: source '$source' does not resolve to a directory in this repo"
		errors=$((errors + 1))
		continue
	fi
	if [ ! -f "$dir/.claude-plugin/plugin.json" ]; then
		echo "FAIL $name: source '$source' resolves, but carries no .claude-plugin/plugin.json — nothing installable is there"
		errors=$((errors + 1))
		continue
	fi
	echo "ok: $name -> $source"
done <<EOF
$entries
EOF

if [ "$errors" -gt 0 ]; then
	echo "validate-marketplace-sources: FAILED — $errors error(s) across $count plugin entr(ies)"
	exit 1
fi

echo "validate-marketplace-sources: OK — $count plugin source(s) resolve"
