#!/usr/bin/env bash
# Mechanical drift guard for the §CP canonical regex and the .claude/skills symlink
# (issue #720). Two invariants, both runnable in CI/locally:
#
#   1. REGEX COPIES — the five CONTROL_PLANE_RE= copies in ship-it, review-code,
#      review-doc, review-skill, and gh-issue-intake-formats (§CP, the source)
#      must be byte-identical to the §CP canonical line. A rename of the plugin
#      path string currently requires ~11 lockstep edits with no guard; this
#      fails CI on any copy that drifts from §CP.
#
#   2. SYMLINK ↔ MARKETPLACE — .claude/skills must resolve to the same directory
#      as marketplace.json's `source` field + /skills. Both express the same plugin
#      root; divergence means the harness loads skills from a different tree than
#      the one the marketplace advertises.
#
# The source-of-truth for invariant 1 is §CP in gh-issue-intake-formats.md (ADR
# 0073 §6): the one definition every consumer must cite. This script extracts it
# and diffs it against the four consumer copies — no copy is re-hardcoded here.
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

# ── Invariant 1: CONTROL_PLANE_RE copies match §CP ──────────────────────────
#
# Extract the canonical value from §CP in gh-issue-intake-formats.md.
# The canonical line has no leading whitespace and no trailing comment:
#   CONTROL_PLANE_RE='...'
FORMATS_MD="$skills_dir/gh-issue-intake-formats.md"
if [ ! -f "$FORMATS_MD" ]; then
	fail "gh-issue-intake-formats.md not found at $FORMATS_MD — cannot extract §CP canonical regex"
	echo "validate-gate-path-drift: FAILED — $errors error(s)"
	exit 1
fi

# `|| true`: under `set -euo pipefail` a no-match `grep` (exit 1) would abort the script here,
# before the explicit empty-check + `fail` below ever runs — losing the diagnostic. Let the
# substitution yield empty so the intended fail-with-message path handles it.
CANONICAL=$(grep "^CONTROL_PLANE_RE=" "$FORMATS_MD" | head -n1 | sed 's/^CONTROL_PLANE_RE=//' || true)
if [ -z "$CANONICAL" ]; then
	fail "§CP canonical CONTROL_PLANE_RE= not found in $FORMATS_MD — line must start with CONTROL_PLANE_RE="
	echo "validate-gate-path-drift: FAILED — $errors error(s)"
	exit 1
fi
ok "§CP canonical regex extracted from gh-issue-intake-formats.md"

# The four consumer skills that carry a copy.
# Each is compared against $CANONICAL after:
#   - stripping leading whitespace (review-doc indents the assignment)
#   - stripping the CONTROL_PLANE_RE= prefix
#   - stripping any trailing whitespace + inline comment (# ...)
CONSUMERS="
ship-it/SKILL.md
review-code/SKILL.md
review-doc/SKILL.md
review-skill/SKILL.md
"

for rel in $CONSUMERS; do
	md="$skills_dir/$rel"
	if [ ! -f "$md" ]; then
		fail "$rel: file not found — cannot verify CONTROL_PLANE_RE copy"
		continue
	fi

	# Extract the first CONTROL_PLANE_RE= line (with or without leading whitespace)
	LINE=$(grep "CONTROL_PLANE_RE=" "$md" | head -n1 || true)   # || true: no-match must hit the fail below, not abort under set -e
	if [ -z "$LINE" ]; then
		fail "$rel: no CONTROL_PLANE_RE= line found — consumer must carry a copy matching §CP"
		continue
	fi

	# Strip leading whitespace
	STRIPPED="${LINE#"${LINE%%[![:space:]]*}"}"
	# Strip "CONTROL_PLANE_RE=" prefix
	VAL="${STRIPPED#CONTROL_PLANE_RE=}"
	# Strip trailing whitespace + inline comment of the form '   # ...'
	# The regex value ends with $' so cut at the first trailing '   #'
	VAL_CLEAN=$(printf '%s\n' "$VAL" | sed "s/'[[:space:]]*#.*$/'/")

	if [ "$VAL_CLEAN" = "$CANONICAL" ]; then
		ok "$rel CONTROL_PLANE_RE matches §CP canonical"
	else
		fail "$rel CONTROL_PLANE_RE has drifted from §CP canonical
  §CP:  $CANONICAL
  copy: $VAL_CLEAN"
	fi
done

# ── Invariant 2: .claude/skills symlink agrees with marketplace source ───────
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

# ── Verdict ──────────────────────────────────────────────────────────────────
if [ "$errors" -gt 0 ]; then
	echo "validate-gate-path-drift: FAILED — $errors error(s); gate-path invariants are broken (issue #720)"
	exit 1
fi

echo "validate-gate-path-drift: OK — $checks checks; CONTROL_PLANE_RE copies and symlink agree with §CP / marketplace"
