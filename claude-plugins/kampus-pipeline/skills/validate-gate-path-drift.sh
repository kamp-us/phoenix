#!/usr/bin/env bash
# Mechanical drift guard for the §CP canonical regex and the .claude/skills symlink
# (issue #720). Two invariants, both runnable in CI/locally:
#
#   1. CONTROL_PLANE_RE ↔ single-source const — the §CP boundary is now single-sourced
#      as the CONTROL_PLANE_RE const in packages/pipeline-cli (issue #2761), emitted by
#      `pipeline-cli control-plane-paths`. The gate skills no longer carry a copy (they
#      re-resolve the boundary from origin/main at run time, #981). The ONE un-importable
#      copy left is the CONTROL_PLANE_RE= line of gh-issue-intake-formats.md, which the
#      live gates read from origin/main. This invariant READS the const via the CLI and
#      diffs it against that one line — the residual drift guard for the last prose
#      surface, no byte-compare of N hand-copies.
#
#   2. SYMLINK ↔ MARKETPLACE — .claude/skills must resolve to the same directory
#      as marketplace.json's `source` field + /skills. Both express the same plugin
#      root; divergence means the harness loads skills from a different tree than
#      the one the marketplace advertises.
#
# The single source for invariant 1 is the pipeline-cli const (ADR 0073 §6; #2761): the
# CLI emits it, this script diffs the formats-doc line against it — no copy re-hardcoded.
#
# Bash 3.2 compatible (macOS default shell). No associative arrays, no process
# substitution with mapfile. Same self-locating idiom as validate-skills.sh.
set -euo pipefail

# `pwd -P` (physical) is load-bearing: this script is invoked via the `.claude/skills`
# symlink (CI runs `bash .claude/skills/validate-gate-path-drift.sh`), so a logical `pwd`
# would resolve skills_dir to the 2-level symlink path `.claude/skills` and `../../..` would
# overshoot past the repo root. Physical resolution lands on the real 3-level plugin path.
skills_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd "$skills_dir/../../.." && pwd -P)"

errors=0
checks=0

fail() { echo "FAIL: $*"; errors=$((errors + 1)); }
ok()   { echo "ok: $*";   checks=$((checks + 1)); }

# Invariant 1: formats-doc CONTROL_PLANE_RE matches the single-source const.
#
# The §CP boundary is single-sourced in packages/pipeline-cli (#2761), emitted by
# `pipeline-cli control-plane-paths`. Read it from THERE (not a byte-compare of N
# hand-copies), then diff it against the one un-importable copy — the CONTROL_PLANE_RE=
# line of gh-issue-intake-formats.md that the live gates re-resolve from origin/main (#981).
FORMATS_MD="$skills_dir/gh-issue-intake-formats.md"
if [ ! -f "$FORMATS_MD" ]; then
	fail "gh-issue-intake-formats.md not found at $FORMATS_MD — cannot verify §CP CONTROL_PLANE_RE"
	echo "validate-gate-path-drift: FAILED — $errors error(s)"
	exit 1
fi

# The single source: the const the CLI prints (raw regex, no surrounding quotes). `|| true`
# so a failed run yields empty and hits the explicit empty-check below instead of aborting
# under set -e.
CONST_RE=$(node "$repo_root/packages/pipeline-cli/src/bin.ts" control-plane-paths 2>/dev/null || true)
if [ -z "$CONST_RE" ]; then
	fail "could not read the §CP CONTROL_PLANE_RE const via \`pipeline-cli control-plane-paths\` (single source: packages/pipeline-cli/src/tools/control-plane-paths/control-plane-re.ts) — is pipeline-cli installed?"
	echo "validate-gate-path-drift: FAILED — $errors error(s)"
	exit 1
fi
ok "§CP CONTROL_PLANE_RE read from the single-source const (pipeline-cli control-plane-paths)"

# The one remaining copy: the origin/main-read line in gh-issue-intake-formats.md. Strip the
# CONTROL_PLANE_RE=' … ' wrapper to compare the raw regex against the const.
FORMATS_RE=$(grep "^CONTROL_PLANE_RE=" "$FORMATS_MD" | head -n1 | sed "s/^CONTROL_PLANE_RE='//; s/'$//" || true)
if [ -z "$FORMATS_RE" ]; then
	fail "§CP CONTROL_PLANE_RE= not found in $FORMATS_MD — the origin/main-read copy must be present and match the const"
elif [ "$FORMATS_RE" = "$CONST_RE" ]; then
	ok "gh-issue-intake-formats.md CONTROL_PLANE_RE matches the single-source const"
else
	fail "gh-issue-intake-formats.md CONTROL_PLANE_RE has drifted from the single-source const
  const:   $CONST_RE
  formats: $FORMATS_RE"
fi

# Invariant 1b: the §CP canonical GUARD_ADR_RE is present (ADR 0164, #3645).
#
# The guard-touching-ADR content predicate (ADR 0164, #2191) is single-sourced in §CP as one
# canonical GUARD_ADR_RE= line in gh-issue-intake-formats.md. Since #3645 there is NO
# hand-copied consumer literal to drift-lock: ship-it Step 0, the review gate, and the driver
# (via trivial-diff) all run the SHARED `pipeline-cli guard-content-probe` verb, whose core
# parses this canonical line directly (like class-probe parses HAS_*_RE) — so the byte-compare
# of a consumer copy is obsolete. This invariant now only asserts the canonical still EXISTS
# (the single source the verb reads); a drift would be a same-file edit, not a copy skew.
GA_CANONICAL=$(grep "^GUARD_ADR_RE=" "$FORMATS_MD" | head -n1 | sed 's/^GUARD_ADR_RE=//' || true)
if [ -z "$GA_CANONICAL" ]; then
	fail "§CP canonical GUARD_ADR_RE= not found in $FORMATS_MD — line must start with GUARD_ADR_RE= (ADR 0164; the guard-content-probe verb reads this single source)"
else
	ok "§CP canonical GUARD_ADR_RE present in gh-issue-intake-formats.md (read by pipeline-cli guard-content-probe)"
fi

# Invariant 1c: HAS_*_RE class-fan copies match §CP (issue #2488).
#
# The four class-classification probes — HAS_CODE_RE / HAS_SKILLS_RE /
# HAS_DOCS_EXCLUDE_RE / HAS_DOCS_RE — are single-sourced as canonical HAS_*_RE='…'
# lines in §CP exactly like CONTROL_PLANE_RE, then copied verbatim into ship-it Step
# 0's class fan. A stale copy mis-classes a PR's changed-path fan (the #2434
# `.glossary/**→has-code` miss that emptied a review namespace and stalled ship-it),
# and that drift was caught only by hand during #2434/#2486 — the exact gap this
# invariant closes. Kept as a pure-bash grep-extract-then-diff (the HAS_*_RE regexes
# are not part of #2761's CONTROL_PLANE_RE single-sourcing) rather than routed through
# `pipeline-cli class-probe`, even though Invariant 1 now makes `node` available in the job.
HAS_NAMES="HAS_CODE_RE HAS_SKILLS_RE HAS_DOCS_EXCLUDE_RE HAS_DOCS_RE"
# Surfaces carrying a copy of the §CP block, enumerated like Invariant 1's CONSUMERS.
# ship-it's copies are one-per-line; reviewer.md's `class_reresolve` fail-closed reference
# packs two per COMPOUND line (`HAS_A='x'; HAS_B='y'   # c`), which the per-assignment
# extraction below handles. Both copy sites must track §CP or the class fan silently drifts
# (issue #2488: reviewer.md's copy was unguarded — drifting it left this gate GREEN). Paths
# are relative to skills_dir, so the sibling agents/ dir is reached with `../agents/…`.
HAS_CONSUMERS="ship-it/SKILL.md ../agents/reviewer.md"

for name in $HAS_NAMES; do
	# Canonical: the single-quoted §CP assignment (NAME='…'). Anchor on the opening
	# quote so this never grabs the double-quoted `NAME="$(reresolve_re …)"` line below it.
	HAS_CANONICAL=$(grep "^$name='" "$FORMATS_MD" | head -n1 | sed "s/^$name=//" || true)
	if [ -z "$HAS_CANONICAL" ]; then
		fail "§CP canonical $name= not found in $FORMATS_MD — line must start with $name='…' (issue #2488)"
		continue
	fi
	ok "§CP canonical $name extracted from gh-issue-intake-formats.md"

	for rel in $HAS_CONSUMERS; do
		md="$skills_dir/$rel"
		if [ ! -f "$md" ]; then
			fail "$rel: file not found — cannot verify $name copy"
			continue
		fi
		# The single-quoted copy (tolerant of leading whitespace); the `'` in the
		# pattern excludes the `NAME="$(reresolve_re …)"` re-assignment line.
		LINE=$(grep "$name='" "$md" | head -n1 || true)   # || true: no-match hits the fail below, not a set -e abort
		if [ -z "$LINE" ]; then
			fail "$rel: no $name='…' line found — consumer must carry a copy matching §CP (issue #2488)"
			continue
		fi
		# Per-assignment extraction (compound-line-aware): pull ONLY this NAME's own
		# single-quoted value, whether it sits alone (ship-it, one per line) or shares a
		# compound line with a sibling assignment + trailing comment (reviewer.md,
		# `HAS_A='x'; HAS_B='y'   # c`). A single-quoted bash string cannot contain a `'`,
		# so `[^']*` up to the next quote is the exact value — the old whole-line strip
		# swallowed the sibling assignment on a compound line and false-FAILed (issue #2488).
		VAL_CLEAN=$(printf '%s\n' "$LINE" | sed "s/.*$name='\([^']*\)'.*/'\1'/")
		if [ "$VAL_CLEAN" = "$HAS_CANONICAL" ]; then
			ok "$rel $name matches §CP canonical"
		else
			fail "$rel $name has drifted from §CP canonical
  §CP:  $HAS_CANONICAL
  copy: $VAL_CLEAN"
		fi
	done
done

# Invariant 2: .claude/skills symlink agrees with marketplace source.
#
# .claude/skills -> ../claude-plugins/kampus-pipeline/skills
# marketplace.json source -> ./claude-plugins/kampus-pipeline
# Invariant: resolved(.claude/skills) == resolved(marketplace source)/skills
SYMLINK="$repo_root/.claude/skills"
MARKETPLACE="$repo_root/.claude-plugin/marketplace.json"

if [ ! -L "$SYMLINK" ]; then
	fail ".claude/skills is not a symlink (expected: symlink into the plugin skills dir)"
else
	ok ".claude/skills is a symlink"

	# Resolve the symlink to an absolute path
	SYMLINK_RESOLVED=$(cd "$(dirname "$SYMLINK")" && cd "$(readlink "$SYMLINK")" && pwd || true)   # || true: a broken target yields empty → drift-fail below, never a set -e abort

	if [ ! -f "$MARKETPLACE" ]; then
		fail ".claude-plugin/marketplace.json not found — cannot verify symlink ↔ marketplace agreement"
	else
		# Extract source field (bash 3.2: grep + sed, no python/jq required)
		MP_SOURCE=$(grep '"source"' "$MARKETPLACE" | head -n1 \
			| sed 's/.*"source"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)   # || true: no-match → empty → fail below, not a set -e abort
		if [ -z "$MP_SOURCE" ]; then
			fail "marketplace.json: no \"source\" field found in plugins entry"
		else
			# Resolve marketplace source to absolute path, then append /skills
			if ! MP_SOURCE_RESOLVED=$(cd "$repo_root" && cd "$MP_SOURCE" && pwd) 2>/dev/null; then
				fail "marketplace.json source \"$MP_SOURCE\" does not resolve to a directory"
			else
				EXPECTED_SYMLINK="$MP_SOURCE_RESOLVED/skills"
				if [ "$SYMLINK_RESOLVED" = "$EXPECTED_SYMLINK" ]; then
					ok ".claude/skills symlink agrees with marketplace source ($MP_SOURCE + /skills)"
				else
					fail ".claude/skills symlink has drifted from marketplace source
  symlink resolves to: $SYMLINK_RESOLVED
  marketplace expects: $EXPECTED_SYMLINK (source=\"$MP_SOURCE\" + /skills)"
				fi
			fi
		fi
	fi
fi

if [ "$errors" -gt 0 ]; then
	echo "validate-gate-path-drift: FAILED — $errors error(s); gate-path invariants are broken (issue #720)"
	exit 1
fi

echo "validate-gate-path-drift: OK — $checks checks; CONTROL_PLANE_RE copies and symlink agree with §CP / marketplace"
