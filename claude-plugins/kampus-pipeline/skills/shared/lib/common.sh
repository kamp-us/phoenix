#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2016
# SC2016 is declared, not waved off: the awk program and the sourcing-idiom matcher below are LITERAL
# text handed to awk and sed. Shell expansion of their `$` would destroy both.
# Cross-script state for the pipeline skills' extracted shell (epic #4435 phase 1).
# Sourced, never executed: it defines functions and sets no shell options, so the sourcing
# script keeps its own `set -euo pipefail`.
#
# DESTINATION CONVENTION — read this before adding any file under skills/ (#4446).
#   per-skill script   claude-plugins/kampus-pipeline/skills/<skill>/scripts/<name>.sh
#   this shared lib    claude-plugins/kampus-pipeline/skills/shared/lib/common.sh
# `.sh` ONLY, at any depth. `.github/CODEOWNERS` gates
# `/claude-plugins/kampus-pipeline/skills/**/*.sh` to @kamp-us/control-plane and §CP's
# CONTROL_PLANE_RE carries the matching `skills/([^/]+/)*[^/]+\.sh$` branch (ADR 0174), so a
# `.sh` file here needs a human approval to merge. A NON-`.sh` file here matches no
# CODEOWNERS row at all — and because that file has no `*` catch-all and the branch's
# required_approving_review_count is 0, an unmatched path merges with ZERO approvals.
# Measured, not assumed: `pipeline-cli cp-classify classify` exits 3 `not-control-plane` for
# `claude-plugins/kampus-pipeline/skills/shared/lib/common.env` and for an extensionless
# `claude-plugins/kampus-pipeline/skills/shared/lib/common`, and exits 0 `control-plane` for
# this file and for `claude-plugins/kampus-pipeline/skills/ship-it/scripts/<name>.sh`. So a
# non-`.sh` helper must land its covering CODEOWNERS row and CONTROL_PLANE_RE branch FIRST.
#
# SOURCING IDIOM — resolve relative to this file so the caller's cwd is irrelevant. From a
# script in a per-skill scripts/ directory:
#   . "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"
#
# That idiom is now a MACHINE CONTRACT, not a style note (ADR 0230, #4541). `kp_skill_source_edges`
# below matches it literally — column 0, single line, no interpolated directory — to decide which
# shared file a skill demonstrably executes. A sourcing form outside it is not resolvable statically,
# so a line that names a `shared/` target in any other shape is UNRESOLVED and reds the skill rather
# than narrowing its surface in silence. Change the idiom and you change that matcher: they move
# together, and `shared/lib/common-test.sh` pins the pair.

# Every file a skill's shell can live in, one absolute path per line: its SKILL.md plus every
# `*.sh` under the skill's own directory — the destination the convention above sends extracted
# blocks to. A validator that greps SKILL.md alone stops guarding the moment a block moves out of
# it, staying green while guarding nothing (#4470); resolving the surface HERE, next to the
# convention that defines it, is what keeps the two in step.
#
# Scoped to the skill's OWN directory on purpose. shared/*.sh is cross-skill, so folding the whole
# directory into every skill's surface would let one skill's marker satisfy another skill's
# per-skill check — the same guard-in-text/absent-in-effect defect, reintroduced from the other
# side (#4470). That exclusion is on DIRECTORY MEMBERSHIP, and it stands. What a caller may add on
# top is per-skill, per-edge and evidence-bearing: see `kp_skill_source_edges` (ADR 0230).
#
# EMITS NOTHING for a skill directory with no SKILL.md and no `*.sh` (and still exits 0 — an
# empty surface is not an error here, it is a fact the CALLER must decide about). A caller that
# collects the lines into an array must therefore check the array is non-empty BEFORE expanding
# it: under `set -u` on bash 3.2 `"${arr[@]}"`/`"${arr[*]}"` on an empty array aborts the script,
# and with a cleanup `trap … EXIT` installed the trap's own exit status becomes the script's — so
# a fail-closed validator exits 0 having printed its FAIL lines. Fail OPEN, invisibly (#4470).
#
# A FAILED scan emits NOTHING on stdout, a diagnostic on stderr, and returns non-zero (#4487).
# `find` exits non-zero on a PARTIAL failure (unreadable subdirectory, a race with a writer)
# while still printing what it could read, so emitting that output would hand the caller a
# silently narrowed — but non-empty — surface, which its `-eq 0` zero-scope guard cannot tell
# from a complete one. Both callers consume this through process substitution, where the return
# status is unobservable even in principle; withholding the output is therefore what makes the
# failure reach them, via the zero-scope guard they already have. Absent ⇒ UNKNOWN, never "no".
kp_skill_shell_surfaces() {
	local skills_dir="$1" skill="$2" md="" found="" sorted=""
	if [ -f "$skills_dir/$skill/SKILL.md" ]; then
		md="$skills_dir/$skill/SKILL.md"
	fi
	if [ -d "$skills_dir/$skill" ]; then
		if ! found="$(find "$skills_dir/$skill" -type f -name '*.sh')"; then
			printf 'kp_skill_shell_surfaces: find failed under %s — the surface is UNKNOWN, not empty; emitting nothing (#4487).\n' "$skills_dir/$skill" >&2
			return 1
		fi
		if [ -n "$found" ] && ! sorted="$(printf '%s\n' "$found" | LC_ALL=C sort)"; then
			printf 'kp_skill_shell_surfaces: sort failed for %s — the surface is UNKNOWN, not empty; emitting nothing (#4487).\n' "$skills_dir/$skill" >&2
			return 1
		fi
	fi
	[ -n "$md" ] && printf '%s\n' "$md"
	[ -n "$sorted" ] && printf '%s\n' "$sorted"
	return 0
}

# One line of shell minus its comment, quote-aware, per line. A guard that greps RAW `.sh` text
# cannot tell wiring from commentary — and did not: `validate-cycle-presence.sh` passed `plan-epic`
# off a docblock line naming the canonical probe path, that line being its ONLY match. The guard was
# satisfied by its own prose (#4541). So every `.sh`-surface grep runs on this output instead.
#
# A `#` opens a comment only OUTSIDE quotes and only at line start or after whitespace, so
# `${var#pat}`, a `*#*)` case pattern and a `#` inside a string all survive. No state crosses lines:
# a heredoc body therefore cannot desync the scan, and the worst it can do is drop a `#` tail — which
# REMOVES text, the fail-closed direction for a presence grep. Residue, stated rather than glossed: a
# comment is dropped, but a needle planted in a `.sh` heredoc or an `if false` block still reads as
# code. Distinguishing those needs a parser; that threat is deception, which §CP review of `skills/**`
# covers, and this guard's threat is drift (ADR 0230, #4505's threat model T8).
#
# `\047` is a single quote, written octally so this awk program contains none and can live inside a
# single-quoted shell string.
kp__STRIP_AWK='
{
	line = $0; out = ""; inq = ""; i = 1; n = length(line)
	while (i <= n) {
		c = substr(line, i, 1)
		if (inq == "") {
			if (c == "#" && (i == 1 || substr(line, i - 1, 1) ~ /[ \t]/)) break
			if (c == "\047" || c == "\"") { inq = c }
			else if (c == "\\") {
				out = out c; i++
				if (i <= n) { out = out substr(line, i, 1); i++ }
				continue
			}
		} else if (inq == "\"") {
			if (c == "\\") {
				out = out c; i++
				if (i <= n) { out = out substr(line, i, 1); i++ }
				continue
			}
			if (c == "\"") inq = ""
		} else if (c == "\047") { inq = "" }
		out = out c; i++
	}
	print out
}'

# The greppable text of the surface files named as arguments, concatenated: `.sh` comment-stripped,
# everything else verbatim. SKILL.md stays raw on purpose — it is markdown, where a fenced block and
# a paragraph are equally greppable, and tightening that prose floor is a separate problem (ADR 0230,
# "knowingly traded").
#
# Buffers, then prints: an unreadable file makes the text UNKNOWN, so it emits NOTHING on stdout, a
# diagnostic on stderr, and returns non-zero (§ZS, ADR 0092). Callers must capture it UNPIPED —
# `text="$(kp_surface_text "${files[@]}")" || …` — because through a pipe the status is unobservable.
# Zero arguments is a caller bug, not an empty surface: `set -u` aborts on an empty array expansion,
# so check the count first.
kp_surface_text() {
	local f out="" chunk
	for f in "$@"; do
		case "$f" in
		*.sh)
			if ! chunk="$(awk "$kp__STRIP_AWK" "$f")"; then
				printf 'kp_surface_text: could not read %s — the surface text is UNKNOWN, not empty; emitting nothing.\n' "$f" >&2
				return 1
			fi
			;;
		*)
			if ! chunk="$(cat "$f")"; then
				printf 'kp_surface_text: could not read %s — the surface text is UNKNOWN, not empty; emitting nothing.\n' "$f" >&2
				return 1
			fi
			;;
		esac
		out="$out$chunk
"
	done
	printf '%s' "$out"
	return 0
}

# The sourcing idiom from this file's header, as a matcher. Anchored at column 0 (the extraction
# convention puts every moved line there), single line, literal relative directory and literal
# `.sh` name — no `$`-interpolation anywhere in either, because an interpolated path is not
# statically resolvable at all and pretending otherwise is how a generic resolver gets defeated
# (#4505 threat model T1). Captures the relative directory and the file name; the sed replacement
# rejoins them with `/`, which is unambiguous because the name capture excludes `/`.
kp__EDGE_IDIOM='^\.  *"$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE\[0\]}")/\([^"$]*\)" && pwd)/\([^"$/]*\.sh\)"$'

# One hop, and the constant IS the rule: only files sourced DIRECTLY by the skill's own surface are
# followed. A literal hidden two hops deep is a FAIL whose fix is to source it directly — a closure
# would re-open the whole-tree fold that the own-directory scoping exists to prevent, and would make
# a skill's surface depend on the shared corpus's internal shape (ADR 0230 rule 2). Raising it is a
# deliberate one-line decision, not a drift.
KP_EDGE_MAX_HOPS=1

kp__is_under() { # <path> <root> — true when <path> IS <root> or sits beneath it
	[ -n "$2" ] || return 1
	case "$1" in
	"$2" | "$2"/*) return 0 ;;
	esac
	return 1
}

# The shared files a skill DEMONSTRABLY executes, one absolute path per line — the skill's scan
# surface widened across its own source edges (ADR 0230). Inclusion is keyed on demonstrated
# dependency, never on directory membership: a shared file is credited to a skill because that
# skill's own text sources it, so a skill that sources nothing gets nothing and #4470's property —
# one skill's marker cannot satisfy another's — survives intact.
#
# WIDEN, NEVER REPLACE: this is the ADDITION to `kp_skill_shell_surfaces`, not a substitute for it.
# Callers union the two, and only for the check that needs it — feeding the widened surface to every
# check would let one shared file satisfy every skill's per-skill marker, which is #4470 rebuilt
# through a legitimate edge (#4505 threat model T3).
#
# FAIL-CLOSED, and loudly by name (ADR 0092 / §ZS, ADR 0230 rule 4). Emits NOTHING on stdout and
# returns non-zero when: the skill's own surface will not resolve; a source line names a `shared/`
# target in any shape but the documented idiom (UNRESOLVED — never silently unfollowed); a resolved
# target is missing or unreadable; or a target lands outside the allowlist (the skill's own dir,
# `shared/scripts/`, `shared/lib/`), which is what stops skill A greening off wiring skill B owns and
# can delete (T4). A named edge that will not resolve makes the surface UNKNOWN, and UNKNOWN is never
# "the needle is absent" — the caller must red on it by name rather than report a confusing
# needle-not-found over a surface it never finished reading (T7).
#
# A source line that resolves to neither — no `shared/` in it, not the idiom — is not an edge claim
# at all and is simply not followed. That direction is safe by construction: this function only ever
# ADDS files, so an unfollowed line yields a NARROWER surface, and a narrower surface can only make a
# presence grep fail.
kp_skill_source_edges() {
	local skills_dir="$1" skill="$2"
	local own_root shared_scripts_root shared_lib_root own_list
	local frontier next visited emitted f dir stripped hits line pair rel name tdir target hop grc allowed
	local NL='
'
	if ! own_root="$(cd -P "$skills_dir/$skill" 2>/dev/null && pwd)"; then
		printf 'kp_skill_source_edges: %s: cannot resolve the skill directory under %s — the edge surface is UNKNOWN, not empty; emitting nothing.\n' "$skill" "$skills_dir" >&2
		return 1
	fi
	# Physical paths on both sides of every allowlist comparison: `skills/` is reached through a
	# symlink, and a logical path compares a resolved target against an unresolved root and never
	# matches (T7). An absent shared root is not an error — it is simply not an allowed target.
	shared_scripts_root="$(cd -P "$skills_dir/shared/scripts" 2>/dev/null && pwd)" || shared_scripts_root=""
	shared_lib_root="$(cd -P "$skills_dir/shared/lib" 2>/dev/null && pwd)" || shared_lib_root=""

	if ! own_list="$(kp_skill_shell_surfaces "$skills_dir" "$skill")"; then
		printf 'kp_skill_source_edges: %s: the own surface is UNKNOWN, so its edges are too; emitting nothing.\n' "$skill" >&2
		return 1
	fi

	# bash 3.2 has no associative arrays: the visited set is a newline-delimited string with linear
	# membership. It is seeded with the own surface so an edge back into the skill's own files is
	# never re-emitted as an addition.
	visited="$NL"
	frontier=""
	while IFS= read -r f; do
		[ -n "$f" ] || continue
		case "$f" in
		*.sh) ;;
		*) continue ;;
		esac
		visited="$visited$f$NL"
		# Record the PHYSICAL form too. Edge targets are resolved physically (the allowlist demands
		# it), so a caller that handed us a logical skills_dir would fail to recognise an own-directory
		# edge as already-present and re-emit a file the own surface already carries.
		case "$f" in
		"$skills_dir/$skill/"*) visited="$visited$own_root/${f#"$skills_dir/$skill/"}$NL" ;;
		esac
		frontier="$frontier$f$NL"
	done <<EOF
$own_list
EOF

	emitted=""
	hop=0
	while [ "$hop" -lt "$KP_EDGE_MAX_HOPS" ]; do
		next=""
		while IFS= read -r f; do
			[ -n "$f" ] || continue
			if ! stripped="$(awk "$kp__STRIP_AWK" "$f")"; then
				printf 'kp_skill_source_edges: %s: could not read %s — the edge surface is UNKNOWN; emitting nothing.\n' "$skill" "$f" >&2
				return 1
			fi
			hits="$(grep -E '^(\.|source)[[:space:]]' <<<"$stripped")"
			grc=$?
			if [ "$grc" -gt 1 ]; then
				printf 'kp_skill_source_edges: %s: grep failed scanning %s for source lines — UNKNOWN; emitting nothing.\n' "$skill" "$f" >&2
				return 1
			fi
			[ "$grc" -eq 1 ] && continue
			while IFS= read -r line; do
				[ -n "$line" ] || continue
				if ! pair="$(sed -n "s|$kp__EDGE_IDIOM|\\1/\\2|p" <<<"$line")"; then
					printf 'kp_skill_source_edges: %s: sed failed matching a source line in %s — UNKNOWN; emitting nothing.\n' "$skill" "$f" >&2
					return 1
				fi
				if [ -z "$pair" ]; then
					case "$line" in
					*shared/*)
						printf 'kp_skill_source_edges: %s: %s carries a source line naming a shared/ target that does NOT match the documented sourcing idiom, so it cannot be resolved statically — the surface is UNKNOWN, not narrower (ADR 0230 rule 4):\n  %s\n' "$skill" "$f" "$line" >&2
						return 1
						;;
					esac
					continue
				fi
				rel="${pair%/*}"
				name="${pair##*/}"
				dir="${f%/*}"
				if ! tdir="$(cd -P "$dir/$rel" 2>/dev/null && pwd)"; then
					printf 'kp_skill_source_edges: %s: %s sources %s, whose directory does not resolve — a NAMED edge that will not resolve is UNKNOWN, never absent (ADR 0230 rule 4).\n' "$skill" "$f" "$pair" >&2
					return 1
				fi
				target="$tdir/$name"
				if [ ! -f "$target" ]; then
					printf 'kp_skill_source_edges: %s: %s sources %s, which resolves to %s — no such file. A broken edge is UNKNOWN, never absent (ADR 0230 rule 4).\n' "$skill" "$f" "$pair" "$target" >&2
					return 1
				fi
				allowed=0
				if kp__is_under "$tdir" "$own_root"; then allowed=1; fi
				if [ "$allowed" -eq 0 ] && kp__is_under "$tdir" "$shared_scripts_root"; then allowed=1; fi
				if [ "$allowed" -eq 0 ] && kp__is_under "$tdir" "$shared_lib_root"; then allowed=1; fi
				if [ "$allowed" -eq 0 ]; then
					printf 'kp_skill_source_edges: %s: %s sources %s, outside the followed-target allowlist (own dir, shared/scripts, shared/lib). Following it would let this skill green off wiring another skill owns and can delete (T4); refusing.\n' "$skill" "$f" "$target" >&2
					return 1
				fi
				case "$visited" in
				*"$NL$target$NL"*) continue ;;
				esac
				visited="$visited$target$NL"
				next="$next$target$NL"
				emitted="$emitted$target$NL"
			done <<EOF
$hits
EOF
		done <<EOF
$frontier
EOF
		frontier="$next"
		hop=$((hop + 1))
	done

	printf '%s' "$emitted"
	return 0
}

# The target repo as `owner/name`. Fails closed rather than yielding an empty string, which
# would silently address `gh api repos//…` (§Target repo resolution, ADR 0062 §1).
kp_repo() {
	if [ -n "${CLAUDE_PIPELINE_REPO:-}" ]; then
		printf '%s\n' "$CLAUDE_PIPELINE_REPO"
		return 0
	fi
	local repo
	repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)" || return 1
	if [ -z "$repo" ]; then
		printf 'kp_repo: could not resolve the target repo — set CLAUDE_PIPELINE_REPO=owner/name, or run inside the target git repo.\n' >&2
		return 1
	fi
	printf '%s\n' "$repo"
}

# Absolute path to the pipeline-cli shim. Never a bare `pipeline-cli`: that resolves against
# PATH, is not there, and dies `command not found` inside a fail-closed wrapper that would
# launder the miss into a verdict (§CLI, ADR 0207). Exit 127 here means the CLI never ran —
# UNKNOWN, never a clean or negative answer.
kp_pcli() {
	local root pcli
	root="${CLAUDE_PLUGIN_ROOT:-}"
	if [ -z "$root" ]; then
		root="$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline"
	fi
	pcli="$root/bin/pipeline-cli"
	if [ ! -x "$pcli" ]; then
		printf 'kp_pcli: UNRESOLVED at %s — the CLI never ran, so the caller has NO result (§CLI).\n' "$pcli" >&2
		return 127
	fi
	printf '%s\n' "$pcli"
}

# The per-run scratch namespace for <slug> (§SP, #3718). `open` is the run's first write of
# scratch state; `path` re-derives it in every later call. Both print the absolute directory.
kp_scratch_open() { kp__scratch "open" "$1"; }
kp_scratch_path() { kp__scratch "path" "$1"; }

# Prefer the `pipeline-cli scratchpad` verb, which owns exclusive allocation; the inline
# recipe is §SP's documented no-CLI fallback for a foreign install (ADR 0062). Exit codes
# mirror the verb's taxonomy: 2 no session id, 3 bad slug, 5 never opened, 6 filesystem.
kp__scratch() {
	local mode="$1" slug="$2" pcli dir
	case "$slug" in
		'' | */* | . | ..)
			printf 'kp_scratch: slug must be a single path segment (§SP).\n' >&2
			return 3
			;;
	esac
	if pcli="$(kp_pcli 2>/dev/null)"; then
		"$pcli" scratchpad "$mode" --slug "$slug"
		return
	fi
	if [ -z "${CLAUDE_CODE_SESSION_ID:-}" ]; then
		printf 'kp_scratch: CLAUDE_CODE_SESSION_ID unset — refusing to write run state to a shared scratch path (§SP).\n' >&2
		return 2
	fi
	dir="${TMPDIR:-/tmp}/kampus-run/$CLAUDE_CODE_SESSION_ID/$slug"
	if [ "$mode" = "open" ]; then
		# Clears what an earlier run of this same slug in this same session left behind. `path`
		# must never do this — it would delete the state the caller came to read.
		rm -rf "$dir"
		if ! mkdir -p "$dir"; then
			printf 'kp_scratch: could not create the per-run scratch dir (§SP).\n' >&2
			return 6
		fi
	elif [ ! -d "$dir" ]; then
		printf 'kp_scratch: namespace for slug %s was never opened in this session (§SP).\n' "$slug" >&2
		return 5
	fi
	printf '%s\n' "$dir"
}
