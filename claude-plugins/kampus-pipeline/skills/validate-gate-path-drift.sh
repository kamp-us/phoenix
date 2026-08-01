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
	fail "could not read the §CP CONTROL_PLANE_RE const via the CLI's \`control-plane-paths\` verb (single source: packages/pipeline-cli/src/tools/control-plane-paths/control-plane-re.ts) — is the CLI shim installed?"
	echo "validate-gate-path-drift: FAILED — $errors error(s)"
	exit 1
fi
ok "§CP CONTROL_PLANE_RE read from the single-source const (the CLI's control-plane-paths verb)"

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

# Invariants 1b / 1c / 1d: every OTHER single-sourced gate boundary (issue #4401).
#
# Until #4401 only CONTROL_PLANE_RE had a typed source. The other ten — GUARD_ADR_RE (ADR 0164),
# the four HAS_*_RE class probes (#2488), the two DOC_VOCAB_*_RE surface probes, CLAIM_RE (ADR
# 0115) and the UI_RE/UI_EXCLUDE_RE pair (#2341/#3071) — lived ONLY as prose lines, so invariant
# 1b could assert no more than "a GUARD_ADR_RE= line exists" and DOC_VOCAB/CLAIM/UI were locked
# by nothing at all. They now have consts in packages/pipeline-cli/src/gate-boundaries.ts, emitted
# by `pipeline-cli control-plane-paths --boundary <NAME>` — so all three checks below are the SAME
# const-vs-copy compare invariant 1 already runs for CONTROL_PLANE_RE, generalized:
#
#   1b — the canonical prose line equals the const (a VALUE compare, not a presence check).
#   1c — every other copy of the name in the corpus equals it too (ship-it's class fan,
#        reviewer.md's compound fail-closed reference, the doc's own illustrative fenced copies).
#   1d — the canonical appears EXACTLY ONCE in its source file. GUARD_ADR_RE appeared twice,
#        byte-identical, and every consumer resolves first-occurrence-wins — so a corrective edit
#        could land on the shadow copy and appear to work (#4401).
#
# The canonical is the COLUMN-0 assignment, because that is what every live consumer resolves
# (`grep '^NAME='` in shell, `/^NAME='…'/m` in TypeScript). An indented occurrence is prose
# illustration, not a machine surface — 1c still value-locks it, 1d does not count it.
BOUNDARY_NAMES="GUARD_ADR_RE HAS_CODE_RE HAS_SKILLS_RE HAS_DOCS_EXCLUDE_RE HAS_DOCS_RE DOC_VOCAB_EXCLUDE_RE DOC_VOCAB_SURFACE_RE CLAIM_RE UI_RE UI_EXCLUDE_RE"
SHIPIT_MD="$skills_dir/ship-it/SKILL.md"
REVIEWER_MD="$skills_dir/../agents/reviewer.md"
# Every corpus file that may carry an assignment copy of a boundary name — INCLUDING the shell the
# skills extracted out of their markdown into scripts/*.sh (#4448). Without that reach, moving a
# fenced block carrying `HAS_*_RE=`/`UI_RE=` fail-closed literals into a script would take those
# copies off 1c's scan surface and leave this invariant green while guarding nothing (#4470/#4486).
COPY_FILES="$FORMATS_MD $SHIPIT_MD $REVIEWER_MD"
for sh in "$skills_dir"/*/scripts/*.sh; do
	# An unmatched glob stays a literal path here (no nullglob in bash 3.2), so test before appending.
	[ -f "$sh" ] && COPY_FILES="$COPY_FILES $sh"
done

# An ASSIGNMENT occurrence: the name preceded by start-of-line, whitespace, or `; ` (reviewer.md
# packs two per compound line). Deliberately NOT a bare substring match — `grep '^NAME='` and
# `sed "s/^NAME='//"` recipe lines also contain `NAME='`, and treating those as copies extracts
# the substitution expression and false-FAILs.
assignment_lines() { grep -nE "(^|[[:space:]]|;)$1='" "$2" 2>/dev/null || true; }
# Pull ONLY this name's own single-quoted value off a line. A single-quoted bash string cannot
# contain a `'`, so `[^']*` up to the next quote is exactly the value (issue #2488).
assignment_value() { printf '%s\n' "$2" | sed "s/.*$1='\([^']*\)'.*/\1/"; }

for name in $BOUNDARY_NAMES; do
	# The single source: the const the emitter prints. `|| true` so a failed run yields empty and
	# hits the explicit empty-check below instead of aborting under set -e.
	CONST_VAL=$(node "$repo_root/packages/pipeline-cli/src/bin.ts" control-plane-paths --boundary "$name" 2>/dev/null || true)
	if [ -z "$CONST_VAL" ]; then
		fail "could not read the $name const via the CLI's \`control-plane-paths --boundary $name\` verb (single source: packages/pipeline-cli/src/gate-boundaries.ts) — issue #4401"
		continue
	fi

	# UI_RE/UI_EXCLUDE_RE are single-sourced in ship-it/SKILL.md, not §CP (§CLASS keeps them there
	# deliberately, and every consumer re-resolves that file from origin/main).
	case "$name" in
		UI_RE|UI_EXCLUDE_RE) SRC_MD="$SHIPIT_MD" ;;
		*) SRC_MD="$FORMATS_MD" ;;
	esac

	# 1d — exactly one column-0 canonical in the source file.
	CANON_COUNT=$(grep -c "^$name='" "$SRC_MD" 2>/dev/null || true)
	[ -n "$CANON_COUNT" ] || CANON_COUNT=0
	if [ "$CANON_COUNT" -eq 0 ]; then
		fail "canonical $name='…' not found at column 0 in $SRC_MD — the live consumers resolve it with ^$name= (issue #4401)"
		continue
	elif [ "$CANON_COUNT" -gt 1 ]; then
		fail "canonical $name='…' appears $CANON_COUNT times at column 0 in $SRC_MD — every consumer resolves first-occurrence-wins, so the later copies are unguarded shadows a corrective edit can land on (issue #4401)"
		continue
	fi
	ok "canonical $name appears exactly once in $(basename "$SRC_MD")"

	# 1b — the canonical equals the const.
	CANON_VAL=$(assignment_value "$name" "$(grep "^$name='" "$SRC_MD" | head -n1)")
	if [ "$CANON_VAL" = "$CONST_VAL" ]; then
		ok "canonical $name matches the single-source const"
	else
		fail "canonical $name has drifted from the single-source const
  const: $CONST_VAL
  prose: $CANON_VAL"
	fi

	# 1c — every other assignment copy in the corpus equals it too.
	for md in $COPY_FILES; do
		if [ ! -f "$md" ]; then
			fail "$md: file not found — cannot verify $name copies"
			continue
		fi
		COPIES=$(assignment_lines "$name" "$md")
		[ -n "$COPIES" ] || continue
		while IFS= read -r hit; do
			[ -z "$hit" ] && continue
			LINE_NO=${hit%%:*}
			COPY_VAL=$(assignment_value "$name" "${hit#*:}")
			# A FAIL-CLOSED SENTINEL (`.`, `$^`) is not a copy of the boundary — it is the value a
			# recipe assigns when the live read fails, and locking it to the const would demand the
			# recipe carry the 300-char pattern as its fallback. Every real boundary is far longer
			# than any sentinel, so the length bound separates them without enumerating either.
			[ "${#COPY_VAL}" -lt 4 ] && continue
			if [ "$COPY_VAL" != "$CONST_VAL" ]; then
				fail "$(basename "$md"):$LINE_NO $name has drifted from the single-source const
  const: $CONST_VAL
  copy:  $COPY_VAL"
			fi
		done <<EOF
$COPIES
EOF
	done
	ok "$name copies across the corpus match the single-source const"
done

# Invariant 2: .claude/skills symlink agrees with the marketplace's plugin root.
#
# .claude/skills -> ../claude-plugins/kampus-pipeline/skills
# marketplace plugin root -> claude-plugins/kampus-pipeline
# Invariant: resolved(.claude/skills) == resolved(plugin root)/skills
#
# "Plugin root" is whichever field the entry's `source` union uses to name it: the bare
# relative-path string, or a pinned `git-subdir` object's `path` (#4643). Both spell the same
# in-repo directory, so the invariant is unchanged — only the field it reads moved.
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
		# Parse the plugin root out of the NAMED entry. The old grep+sed took the file's first
		# `"source"` line, which only worked while every entry was a bare string and kampus-pipeline
		# happened to be listed first; against a `git-subdir` object it matched the opening brace and
		# silently yielded a path that resolves to nothing. Node already gates this script (the
		# boundary consts above are read through it), so parsing the JSON adds no dependency.
		MP_SOURCE=$(node -e '
			const m = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
			const entry = (m.plugins || []).find((p) => p.name === "kampus-pipeline");
			if (!entry) process.exit(1);
			const s = entry.source;
			const root = typeof s === "string" ? s : s && s.source === "git-subdir" ? s.path : null;
			if (!root) process.exit(1);
			process.stdout.write(root);
		' "$MARKETPLACE" 2>/dev/null || true)   # || true: a parse/shape failure yields empty → fail below, not a set -e abort
		if [ -z "$MP_SOURCE" ]; then
			fail "marketplace.json: could not resolve the kampus-pipeline entry's plugin root (expected a relative-path \"source\" string or a \"git-subdir\" source with a \"path\")"
		else
			# Resolve the plugin root to an absolute path, then append /skills
			if ! MP_SOURCE_RESOLVED=$(cd "$repo_root" && cd "$MP_SOURCE" && pwd) 2>/dev/null; then
				fail "marketplace.json plugin root \"$MP_SOURCE\" does not resolve to a directory"
			else
				EXPECTED_SYMLINK="$MP_SOURCE_RESOLVED/skills"
				if [ "$SYMLINK_RESOLVED" = "$EXPECTED_SYMLINK" ]; then
					ok ".claude/skills symlink agrees with the marketplace plugin root ($MP_SOURCE + /skills)"
				else
					fail ".claude/skills symlink has drifted from the marketplace plugin root
  symlink resolves to: $SYMLINK_RESOLVED
  marketplace expects: $EXPECTED_SYMLINK (plugin root \"$MP_SOURCE\" + /skills)"
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
