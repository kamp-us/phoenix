#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2016,SC2086
# SC2016 is declared, not waved off: the awk program and the sourcing-idiom matcher below are LITERAL
# text handed to awk and sed. Shell expansion of their `$` would destroy both. SC2086 is raised by
# exactly one line — `set -- $hits` in the byte-moved `lane_worktree` — where the split IS the
# mechanism: quoting it would collapse N candidate worktrees into one word and defeat the `-eq 1`
# ambiguity refusal. It is declared here rather than quoted away because that block is a byte-move
# (#4449) and rewriting the moved glue is phase 2 (#1929).
# Cross-script state for the pipeline skills' extracted shell (epic #4435 phase 1).
# Sourced, never executed: it defines functions and sets no shell options, so the sourcing
# script keeps its own `set -euo pipefail`.
#
# DESTINATION CONVENTION — read this before adding a pipeline shell file (#4446, #4484).
#   per-skill script   claude-plugins/kampus-pipeline/skills/<skill>/scripts/<name>.sh
#   this shared lib    claude-plugins/kampus-pipeline/lib/common.sh
# The lib sits beside `bin/`, NOT under `skills/`: `shared/` was never a skill, and it survived
# in the skills namespace only because `validate-skills.sh` enumerates via a `*/SKILL.md` glob
# that skips it (#4484). Both destinations are §CP by DIRECTORY, at any depth and any extension:
# `.github/CODEOWNERS` gates `/claude-plugins/kampus-pipeline/skills/` and
# `/claude-plugins/kampus-pipeline/lib/` to @kamp-us/control-plane, and CONTROL_PLANE_RE carries
# the matching `^claude-plugins/kampus-pipeline/(skills|lib)/` branches. So every file under
# either — a `README.md`, a `.env`, an extensionless helper — needs a human approval to merge.
# A destination OUTSIDE both is the hazard: that file has no `*` catch-all and the branch's
# required_approving_review_count is 0, so a path matching NO row merges with ZERO approvals.
# Measured, not assumed: `pipeline-cli cp-classify classify` exits 0 `control-plane` for this
# file and for `claude-plugins/kampus-pipeline/skills/ship-it/scripts/<name>.sh`, and exits 3
# `not-control-plane` for `claude-plugins/kampus-pipeline/scripts/common.sh`. So a helper landing
# anywhere else must bring its covering CODEOWNERS row and CONTROL_PLANE_RE branch FIRST, in the
# SAME commit — that atomicity is what this file's own relocation had to honour.
#
# OUTPUT CHANNEL — stdout is the ANSWER, stderr is everything else, and a non-zero return means the
# answer was never produced (UNKNOWN, never the permissive one). Every function below already obeys
# it; the rule, the exit taxonomy, and why a non-zero with 0 bytes of stdout is a CALLER-side
# fail-open are `.patterns/skill-script-io-contract.md` (#4510, ADR 0232).
#
# SOURCING IDIOM — resolve relative to this file so the caller's cwd is irrelevant. From a
# script in a per-skill scripts/ directory:
#   . "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"
#
# That idiom is now a MACHINE CONTRACT, not a style note (ADR 0230, #4541). `kp_skill_source_edges`
# below matches it literally — column 0, single line, no interpolated directory — to decide which
# shared file a skill demonstrably executes. A sourcing form outside it is not resolvable statically,
# so a line that names a shared target — `skills/shared/` or this `lib/` — in any other shape is
# UNRESOLVED and reds the skill rather than narrowing its surface in silence. Change the idiom and
# you change that matcher: they move together, and `lib/common-test.sh` pins the pair.

# Every file a skill's shell can live in, one absolute path per line: its SKILL.md plus every
# `*.sh` under the skill's own directory — the destination the convention above sends extracted
# blocks to. A validator that greps SKILL.md alone stops guarding the moment a block moves out of
# it, staying green while guarding nothing (#4470); resolving the surface HERE, next to the
# convention that defines it, is what keeps the two in step.
#
# Scoped to the skill's OWN directory on purpose. The shared shell is cross-skill, so folding the whole
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
# `${var#pat}`, a `*#*)` case pattern and a `#` inside a string all survive. No state crosses lines,
# so a heredoc body cannot desync the scan.
#
# Residue, stated rather than glossed, and it runs in BOTH directions — the common case removes text
# (fail-closed for a presence grep: a dropped `#` tail can only make a needle harder to find), but
# that is not exhaustive. Measured counter-example in the fail-OPEN direction: on a line carrying an
# unbalanced double quote, the scan stays in-quote to end of line, so a `#` comment after it
# SURVIVES. Likewise a needle planted in a `.sh` heredoc or an `if false` block still reads as code.
# All of that sits inside T8's ACCEPTED residue rather than being a defect: separating them needs a
# parser, shellcheck reds an unbalanced quote, and the threat they serve is deception — covered by
# §CP review of `skills/**` — where this guard's threat is drift (ADR 0230, #4505's threat model T8).
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
# returns non-zero when: the skill's own surface will not resolve; a source line names a shared
# target in any shape but the documented idiom (UNRESOLVED — never silently unfollowed); a resolved
# target is missing or unreadable; or a target lands outside the allowlist (the skill's own dir,
# `skills/shared/scripts/`, the plugin `lib/`), which is what stops skill A greening off wiring skill B owns and
# can delete (T4). A named edge that will not resolve makes the surface UNKNOWN, and UNKNOWN is never
# "the needle is absent" — the caller must red on it by name rather than report a confusing
# needle-not-found over a surface it never finished reading (T7).
#
# A source line that resolves to neither — no shared root named in it, not the idiom — is not an edge claim
# at all and is simply not followed. That direction is safe by construction: this function only ever
# ADDS files, so an unfollowed line yields a NARROWER surface, and a narrower surface can only make a
# presence grep fail.
kp_skill_source_edges() {
	local skills_dir="$1" skill="$2"
	local own_root shared_scripts_root plugin_lib_root own_list
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
	plugin_lib_root="$(cd -P "$skills_dir/../lib" 2>/dev/null && pwd)" || plugin_lib_root=""

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
					# The UNRESOLVED trigger names BOTH shared roots — `skills/shared/` and the plugin
					# `lib/` the library moved to (#4484). Missing either would let a non-idiom source
					# line naming that root read as "not an edge claim" and silently narrow the surface.
					*shared/* | */lib/* | */lib\"*)
						printf 'kp_skill_source_edges: %s: %s carries a source line naming a shared target (skills/shared/ or the plugin lib/) that does NOT match the documented sourcing idiom, so it cannot be resolved statically — the surface is UNKNOWN, not narrower (ADR 0230 rule 4):\n  %s\n' "$skill" "$f" "$line" >&2
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
				if [ "$allowed" -eq 0 ] && kp__is_under "$tdir" "$plugin_lib_root"; then allowed=1; fi
				if [ "$allowed" -eq 0 ]; then
					printf 'kp_skill_source_edges: %s: %s sources %s, outside the followed-target allowlist (own dir, skills/shared/scripts, the plugin lib/). Following it would let this skill green off wiring another skill owns and can delete (T4); refusing.\n' "$skill" "$f" "$target" >&2
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
# The fallback resolves from THIS FILE, never from `git rev-parse --show-toplevel`. The old git
# derivation assumed the plugin is vendored in the repo the caller is standing in — true in phoenix,
# false for every marketplace consumer, where it named a `claude-plugins/` directory that does not
# exist and turned every verb call into a 127 (#4605). This file always sits at `<plugin>/lib/`,
# in-repo or in a plugin cache, so its own location is the one true answer and needs no subprocess.
kp_pcli() {
	local root pcli
	root="${CLAUDE_PLUGIN_ROOT:-}"
	if [ -z "$root" ]; then
		root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)"
	fi
	pcli="$root/bin/pipeline-cli"
	if [ ! -x "$pcli" ]; then
		printf 'kp_pcli: UNRESOLVED at %s — the CLI never ran, so the caller has NO result (§CLI).\n' "$pcli" >&2
		return 127
	fi
	printf '%s\n' "$pcli"
}

# The head-handle resolver's own status, chosen ABOVE `kp__scratch`'s 2/3/4/5/6 taxonomy (and clear
# of 126/127) so the two can never collide: the namespace opened fine, it just holds no handle file.
# It and 5 (namespace never opened) are the ONLY two statuses that mean "nothing was materialized";
# every other non-zero from a `head-env.sh` means the resolver COULD NOT LOOK, which is UNKNOWN and
# must never be read as a clean no-op (§ZS, ADR 0092; #4972/#5193). Defined once here because all
# three review gates carry their own `head-env.sh` / `teardown-head.sh` pair and must not diverge.
# shellcheck disable=SC2034  # read by the sourcing script, not by this file
KP_HEAD_HANDLE_ABSENT=20

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

kp__phys() { # <path> — its physical form, or the path itself when the directory is gone (a prunable
	# worktree registration outlives its directory, and it still pins the branch).
	# The `cd` runs in a subshell so this can never move the CALLER's cwd — every call site wraps it
	# in `$( … )` today, but a bare call would otherwise relocate the shell that sourced this lib.
	(cd -P "$1" 2>/dev/null && pwd -P) || printf '%s\n' "$1"
}

# ---------------------------------------------------------------------------------------------
# THE LANE STAMP'S LIFECYCLE (#4868). The stamp used to be written once and never touched again,
# which made "is that tree a lane still building?" unanswerable: every sibling subagent of one
# session stamps the SAME id (the #4500 finding recorded under `lane_worktree` below), so a
# finished lane's leftover tree was byte-identical to a live one and the `live-lane` branch could
# never be false. Identity is not liveness. So the stamp now has three lifecycle files, all in a
# worktree's PRIVATE per-worktree git dir (outside the working tree, never committed, unique per
# worktree) — and the pin classifier reads the lifecycle, never the id alone:
#
#   kampus-lane          identity — WHICH lane proved this tree (step4-preflight.sh, once)
#   kampus-lane.beat     liveness — WHEN that lane last moved git here (wt_preflight, every mutation)
#   kampus-lane.retired  finished — the lane released it (step8-claim-release.sh, or a proven release)
#
# The retired name is the pre-existing operator convention `lane_worktree`'s glob already skips; what
# is new is that a lane now produces one itself, so the routine case stops being permanent.
# ---------------------------------------------------------------------------------------------

kp__lane_admin() { # <common-git-dir> <physical-worktree-root> — the repo's private bookkeeping dir
	# for that worktree (`<common>/worktrees/<name>`), which is where its lane files live. Empty and
	# non-zero when no registration names that root.
	local common="$1" want="$2" gd r
	for gd in "$common"/worktrees/*/gitdir; do
		[ -f "$gd" ] || continue
		r="$(cat "$gd")"
		[ "$(kp__phys "${r%/.git}")" = "$want" ] || continue
		printf '%s\n' "${gd%/gitdir}"
		return 0
	done
	return 1
}

kp_lane_beat() { # <per-worktree-git-dir> — record that this lane is working, NOW.
	# Called from `wt_preflight`, i.e. immediately before every git mutation this lane makes, so a
	# lane that is doing anything at all leaves a fresh beat. Best-effort on purpose: a beat that
	# cannot be written must never block the mutation, because a MISSING beat is read as
	# liveness-unknown (the conservative side), never as liveness-proven.
	local gd="${1:-}"
	[ -n "$gd" ] && [ -f "$gd/kampus-lane" ] || return 0
	date +%s > "$gd/kampus-lane.beat" 2>/dev/null
	return 0
}

kp_lane_beat_age() { # <per-worktree-git-dir> — seconds since that lane last proved it was working.
	# No readable beat ⇒ nothing on stdout and non-zero: the age is UNKNOWN, never 0 (§ZS) — 0 would
	# read as "just now", the permissive answer.
	local beat now
	beat="$(cat "${1:-}/kampus-lane.beat" 2>/dev/null)" || return 1
	case "$beat" in '' | *[!0-9]*) return 1 ;; esac
	now="$(date +%s)"
	case "$now" in '' | *[!0-9]*) return 1 ;; esac
	printf '%d\n' "$((now - beat))"
}

kp_lane_retire() { # <per-worktree-git-dir> — this lane is finished with its tree; retire its stamp.
	# Renames ONE file inside the repo's private worktree bookkeeping. It removes no worktree, uses no
	# `--force`, and writes nothing into any working tree — the leftover files stay exactly as they
	# are. Idempotent: an already-retired or never-stamped lane is a clean no-op.
	local gd="${1:-}"
	[ -n "$gd" ] || return 1
	[ -f "$gd/kampus-lane" ] || return 0
	mv -f "$gd/kampus-lane" "$gd/kampus-lane.retired" || return 1
	rm -f "$gd/kampus-lane.beat"
	return 0
}

# Is the tree at <pin-root> PROVABLY done with <branch> — nothing lost if the ref moves under it?
# Three independent, read-only facts, ALL required; this is the hand-clearing an operator has had to
# perform per occurrence, encoded. It writes nothing anywhere. stdout is the reason the proof FAILED
# (empty on success), so a refusal can name which fact was missing rather than "it is pinned".
kp_lane_quiescent() { # <my-worktree> <pin-root> <branch>
	local mine="$1" root="$2" branch="$3" dirty head tip
	if ! dirty="$(git -C "$root" status --porcelain 2>/dev/null)"; then
		printf 'its working tree cannot be read at all (`git -C %s status` failed)\n' "$root"
		return 1
	fi
	if [ -n "$dirty" ]; then
		printf 'it holds UNCOMMITTED work (`git -C %s status --porcelain` is not empty)\n' "$root"
		return 1
	fi
	head="$(git -C "$root" rev-parse --verify HEAD 2>/dev/null)"
	tip="$(git -C "$mine" rev-parse --verify "refs/heads/$branch" 2>/dev/null)"
	if [ -z "$head" ] || [ -z "$tip" ]; then
		printf 'its HEAD or the tip of %s could not be resolved\n' "$branch"
		return 1
	fi
	if [ "$head" != "$tip" ]; then
		printf 'its HEAD (%s) is not the tip of %s (%s) — that tree is mid-flight\n' "$head" "$branch" "$tip"
		return 1
	fi
	# Containment in THIS branch's own upstream, not in any `refs/remotes/*` — an unrelated
	# remote-tracking ref that is stale-forward (it still names a commit an upstream force-push
	# dropped) would answer "safely on a remote" for work that is no longer there, and this is the
	# predicate that decides whether a pin is RELEASED, so its false positive is the fail-open one.
	# An absent `origin/<branch>` makes `--is-ancestor` non-zero, which refuses — the safe direction.
	if ! git -C "$mine" merge-base --is-ancestor "$head" "refs/remotes/origin/$branch" 2>/dev/null; then
		printf 'its HEAD (%s) is not contained in origin/%s — that work exists only in that tree\n' "$head" "$branch"
		return 1
	fi
	return 0
}

# The SANCTIONED co-checkout: put MY lane on <branch> while another tree still holds it. It leaves
# that tree's files untouched and removes nothing; its HEAD follows the branch ref from here on.
kp__co_checkout() { # <my-worktree> <branch> <pin-root>
	printf 'kp_switch_head_branch: %s is pinned by worktree %s — not this lane, not the primary checkout. Taking the SANCTIONED co-checkout in MY lane (%s): `git switch --ignore-other-worktrees`. That tree is left in place and its files are untouched; no worktree is removed. Its HEAD will follow the branch ref once this repair rebases.\n' "$2" "$3" "$1" >&2
	if ! git -C "$1" switch --ignore-other-worktrees "$2" >&2; then
		printf 'kp_switch_head_branch: the sanctioned co-checkout of %s into %s failed (git'\''s error is above) — the pin is NOT what blocked it. REMEDY: resolve what git named in %s and re-run this step. Do NOT detach HEAD to work around it: a detached repair skips the rebase onto origin/main and `verified-push` resolves a detached HEAD to UNKNOWN and pushes nothing. NOTHING was switched.\n' "$2" "$1" "$1" >&2
		return 1
	fi
	return 0
}

# WHICH worktree holds <branch> checked out right now — the classifier repair R2 routes on when a
# leftover build lane still pins the PR's head branch (#4826). Prints exactly two lines:
#
#   PIN=free|mine|primary|live-lane|dormant-lane|other
#   PINROOT=<absolute worktree root>          (empty only for `free`)
#
# The five non-free states are NOT interchangeable, which is the whole reason this is a classifier
# and not a boolean: co-checking-out a branch (`git switch --ignore-other-worktrees`) leaves the
# pinning tree's FILES untouched but lets a later rebase move the branch ref under its HEAD. That is
# harmless for a finished lane's leftover tree (`other`), and it is exactly the #2270
# primary-checkout-corruption class for the shared primary tree (`primary`) or a lane that may still
# be building on it (`live-lane`).
#
# THE SAME-SESSION TREE SPLITS IN TWO, AND THE SPLIT IS THE POINT (#4868). A stamp equal to this
# session's id says only that a SIBLING LANE proved that tree — it cannot say whether that lane is
# still building, because every sibling subagent of one session shares $CLAUDE_CODE_SESSION_ID (the
# measured #4500 finding recorded under `lane_worktree`). Keyed on identity alone the `live-lane`
# branch was true for every same-session tree forever, which is not fail-closed, it is stuck. So the
# liveness evidence is the stamp's LIFECYCLE, which the lane itself moves:
#
#   live-lane     stamped by this session AND beating within $KP_LANE_BEAT_TTL — a lane that moved
#                 git here recently. REFUSE: the rebase would move its HEAD mid-flight.
#   dormant-lane  stamped by this session, but the beat is stale or absent — liveness UNKNOWN, stated
#                 as its own state instead of guessed either way. `kp_switch_head_branch` then has to
#                 PROVE the tree is finished (`kp_lane_quiescent`) before it may release the pin.
#
# A finished lane retires its own stamp (step8), so the routine case never reaches either: it reads
# `other`. A foreign session's stamp proves nothing either way and also resolves `other` — the
# mitigation for it is that the co-checkout removes nothing and writes nothing into that tree.
#
# A read it cannot complete is UNKNOWN and returns non-zero with nothing on stdout — never `free`,
# which is the permissive branch (§ZS, ADR 0092).
kp_branch_pin() {
	local mine="$1" branch="$2"
	local common list line cur primary="" hits="" mine_p hit_p state r stamp admin age
	local ttl="${KP_LANE_BEAT_TTL:-900}"
	local NL='
'
	if [ -z "$mine" ] || [ -z "$branch" ]; then
		printf 'kp_branch_pin: need <my-worktree-root> <branch> — the pin state is UNKNOWN, never free.\n' >&2
		return 1
	fi
	if ! common="$(git -C "$mine" rev-parse --git-common-dir 2>/dev/null)"; then
		printf 'kp_branch_pin: %s is not inside a git repository — the pin state is UNKNOWN, never free.\n' "$mine" >&2
		return 1
	fi
	case "$common" in /*) ;; *) common="$mine/$common" ;; esac
	if ! common="$(cd "$common" 2>/dev/null && pwd -P)"; then
		printf 'kp_branch_pin: could not resolve the common git dir of %s — UNKNOWN, never free.\n' "$mine" >&2
		return 1
	fi
	if ! list="$(git -C "$mine" worktree list --porcelain 2>/dev/null)"; then
		printf 'kp_branch_pin: `git worktree list` failed under %s — UNKNOWN, never free.\n' "$mine" >&2
		return 1
	fi
	# git lists the MAIN worktree first, so the first record names the primary checkout; a detached
	# worktree emits no `branch` line and therefore pins nothing.
	while IFS= read -r line; do
		case "$line" in
		"worktree "*)
			cur="${line#worktree }"
			[ -n "$primary" ] || primary="$cur"
			;;
		"branch refs/heads/$branch") hits="$hits$cur$NL" ;;
		esac
	done <<EOF
$list
EOF
	if [ -z "$hits" ]; then
		printf 'PIN=free\nPINROOT=\n'
		return 0
	fi
	mine_p="$(kp__phys "$mine")"
	# SEVERAL trees can legitimately hold one branch — that is precisely the state the sanctioned
	# co-checkout leaves behind — and MINE wins the read, so re-running the step after a co-checkout
	# resolves `mine` and is a clean no-op rather than a repeat refusal.
	hit_p=""
	while IFS= read -r line; do
		[ -n "$line" ] || continue
		r="$(kp__phys "$line")"
		if [ "$r" = "$mine_p" ]; then
			hit_p="$mine_p"
			break
		fi
		[ -n "$hit_p" ] || hit_p="$r"
	done <<EOF
$hits
EOF
	if [ "$hit_p" = "$mine_p" ]; then
		state="mine"
	elif [ "$hit_p" = "$(kp__phys "$primary")" ] || [ "$hit_p" = "$(kp__phys "${common%/.git}")" ]; then
		state="primary"
	else
		state="other"
		admin="$(kp__lane_admin "$common" "$hit_p")"
		if [ -n "$admin" ]; then
			stamp="$(cat "$admin/kampus-lane" 2>/dev/null)"
			if [ -n "${CLAUDE_CODE_SESSION_ID:-}" ] && [ "$stamp" = "$CLAUDE_CODE_SESSION_ID" ]; then
				# Identity got us this far; only the beat can say live from left-behind. An
				# unreadable beat is UNKNOWN, so it lands in `dormant-lane` — which still refuses
				# until the tree is PROVED finished, never in `other`, which co-checks-out at once.
				age="$(kp_lane_beat_age "$admin")"
				if [ -n "$age" ] && [ "$age" -lt "$ttl" ]; then
					state="live-lane"
				else
					state="dormant-lane"
				fi
			fi
		fi
	fi
	printf 'PIN=%s\nPINROOT=%s\n' "$state" "$hit_p"
}

# Put MY lane's HEAD on <branch> whatever pins it — the SANCTIONED path repair R2 takes, so no repair
# agent has to invent one (#4826). Narration and every refusal go to stderr; stdout stays empty
# because this is an effect, not an answer.
#
# It removes NO worktree, on any branch — not even a prunable registration, and never with `--force`.
# A build lane's tree can hold real uncommitted work, so eating one is strictly worse than the bug
# this closes; the co-checkout needs no removal at all, which is why that is the shape chosen.
#
# Every refusal names its remedy in the refusal line. A fail-closed stop with no stated way forward
# is what produced the improvisations in the first place, one of which silently dropped the rebase
# onto latest `main` and the `verified-push` verification.
kp_switch_head_branch() {
	local wt="$1" branch="$2" pin state root common admin why age
	if ! pin="$(kp_branch_pin "$wt" "$branch")"; then
		printf 'kp_switch_head_branch: the pin state of %s is UNKNOWN (see above), so the sanctioned path cannot be chosen. REMEDY: re-run from your own lane once `git worktree list` reads cleanly. NOTHING was switched.\n' "$branch" >&2
		return 1
	fi
	state="$(printf '%s\n' "$pin" | sed -n 's/^PIN=//p')"
	root="$(printf '%s\n' "$pin" | sed -n 's/^PINROOT=//p')"
	case "$state" in
	mine)
		printf 'kp_switch_head_branch: %s already holds %s — nothing to switch.\n' "$wt" "$branch" >&2
		;;
	free)
		if ! git -C "$wt" switch "$branch" >&2; then
			printf 'kp_switch_head_branch: `git switch %s` failed in %s, and NO worktree holds that branch — so this is NOT the pinned-branch case and its remedy does not apply. REMEDY: read git'\''s error above; a local change blocking the switch is committed or stashed IN %s, an unknown branch needs `git fetch origin` first. NOTHING was switched.\n' "$branch" "$wt" "$wt" >&2
			return 1
		fi
		;;
	other)
		kp__co_checkout "$wt" "$branch" "$root" || return 1
		;;
	dormant-lane)
		# Liveness unknown, so nothing is assumed in either direction: the pin is released only on
		# POSITIVE proof that the tree has nothing left to lose, and the refusal below is what the
		# unproven case gets. This is the one path that can retire another lane's stamp, and it does
		# so by renaming one bookkeeping file — no worktree removed, no `--force`, not one byte
		# written into that tree.
		if ! why="$(kp_lane_quiescent "$wt" "$root" "$branch")"; then
			printf 'kp_switch_head_branch REFUSED (fail-closed): %s is pinned by %s, a worktree stamped with THIS session'\''s lane id (%s) whose heartbeat is stale or absent — that lane is not provably alive, but it is not provably finished either: %s. Releasing the pin now could move the branch ref under work that exists nowhere else. REMEDY: re-run this same step yourself — no sibling tree, no human. It re-probes on every run and releases the pin by itself as soon as that tree is clean, sitting on the tip of %s, and pushed to origin. If this same reason keeps printing, that tree holds work that is not yours to move — post THIS line on the PR and stop. Do NOT remove that worktree and do NOT `--force` anything. NOTHING was switched.\n' "$branch" "$root" "${CLAUDE_CODE_SESSION_ID:-<unset>}" "$why" "$branch" >&2
			return 1
		fi
		common="$(git -C "$wt" rev-parse --git-common-dir 2>/dev/null)"
		case "$common" in /*) ;; *) common="$wt/$common" ;; esac
		common="$(cd "$common" 2>/dev/null && pwd -P)"
		admin="$(kp__lane_admin "$common" "$root")"
		age="$(kp_lane_beat_age "$admin")" # read BEFORE the retire below deletes the beat file
		if [ -z "$admin" ] || ! kp_lane_retire "$admin"; then
			printf 'kp_switch_head_branch REFUSED (fail-closed): %s is pinned by the dormant lane tree %s, which IS provably finished with it, but its lane stamp could not be retired (bookkeeping dir: %s). Releasing the pin without retiring the stamp would leave the next repair reading the same stuck state. REMEDY: re-run this step yourself; if it keeps failing here, the repo'\''s worktree bookkeeping under %s is not writable — post THIS line on the PR. Do NOT remove that worktree. NOTHING was switched.\n' "$branch" "$root" "${admin:-<not registered>}" "${common:-<unresolved>}" >&2
			return 1
		fi
		printf 'kp_switch_head_branch: %s is pinned by %s, a same-session lane whose heartbeat is stale (%s) and whose tree is PROVABLY finished with it — clean, on the tip of %s, and that commit is contained in origin/%s. Retired its stamp (kampus-lane -> kampus-lane.retired, one bookkeeping file; the worktree and every file in it are untouched) and taking the sanctioned co-checkout.\n' "$branch" "$root" "${age:+${age}s ago}${age:-never beat}" "$branch" "$branch" >&2
		kp__co_checkout "$wt" "$branch" "$root" || return 1
		;;
	primary)
		printf 'kp_switch_head_branch REFUSED (fail-closed): %s is checked out in the PRIMARY checkout %s. Co-checking it out here would let this repair'\''s rebase move the branch ref under the shared primary tree (the #2270 primary-corruption class). REMEDY: release %s in that checkout (`git switch <some other branch>`), then re-run this step. Do NOT remove any worktree. NOTHING was switched.\n' "$branch" "$root" "$branch" >&2
		return 1
		;;
	live-lane)
		# The remedies this used to name were both unreachable from the refusing agent — `wt_preflight`
		# refuses a sibling tree, and "wait" never cleared while the stamp was written once and never
		# moved (#4868). Both are now real: the beat goes stale on its own, and a finishing lane retires
		# its stamp, so re-running IS the way forward and it is a step this agent can take.
		printf 'kp_switch_head_branch REFUSED (fail-closed): %s is checked out in %s, a worktree stamped with THIS session'\''s lane id (%s) whose heartbeat is FRESH — a sibling lane that moved git there in the last %ss and is building on it right now. The rebase would move its HEAD mid-flight. REMEDY: re-run this same step yourself in a few minutes — no sibling tree, no human. It clears by itself two ways: a lane retires its stamp when it finishes, and a lane that stops beating drops to liveness-unknown, where this step releases the pin as soon as that tree is provably clean, at the branch tip and pushed. Do NOT remove that worktree — it can hold uncommitted work. NOTHING was switched.\n' "$branch" "$root" "${CLAUDE_CODE_SESSION_ID:-<unset>}" "${KP_LANE_BEAT_TTL:-900}" >&2
		return 1
		;;
	*)
		printf 'kp_switch_head_branch REFUSED (fail-closed): the pin classifier returned no state for %s — UNKNOWN, never free. REMEDY: run `git worktree list --porcelain` from %s and report what it shows. NOTHING was switched.\n' "$branch" "$wt" >&2
		return 1
		;;
	esac
	return 0
}

# The per-mutation worktree guard and the lane resolver under it. They live HERE, in the file every
# pipeline shell script already sources, because they have TWO classes of caller: the EXECUTED
# `write-code/scripts/step4-wt-preflight.sh`, which runs `wt_preflight` in a subprocess and prints
# the root it resolved (ADR 0232), and four SOURCED siblings — `step4-branch.sh`, `step5-push.sh`,
# `stepR2-branch-rebase.sh`, `stepR3-push-and-note.sh` — which call `wt_preflight` in the agent's own
# shell and then read the `$WT` it leaves there. A shell function reaches a sourced caller only from
# a file that caller sources, so hosting these in the executed script alone left those four calling a
# function that had ceased to exist, with no CI check able to see it (#4449 repair round 2). The
# names stay unprefixed, against this file's `kp_` convention, because they ARE the names those
# callers and write-code/SKILL.md refer to.
#
# The block below was extracted from write-code/SKILL.md's per-mutation-preflight blockquote (epic
# #4435 phase 1, #4449) and keeps that blockquote's two-space indent rather than this file's tabs;
# SKILL.md now carries prose only, so the lib is the single source and reindenting it would be pure
# diff noise.

# Resolve MY worktree by IDENTITY, never from cwd (#4398). `git rev-parse --show-toplevel` answers
# "where is the cwd" — which a between-calls reset makes a different question from "which tree is
# mine". Deriving $WT from it and then re-deriving the toplevel to compare against is one answer
# checked against itself: always equal, so its failure branch could never print. The stamp is
# CONTENT written once when $WT was trustworthy, so these two operands can genuinely differ.
#
# THE SESSION ID NAMES A SESSION, NOT A WORKTREE (#4500). Every sibling subagent of one dispatching
# session shares $CLAUDE_CODE_SESSION_ID, so each lane's opening preflight stamps its own tree with
# the SAME value and a session-wide search finds N of them — making the `-eq 1` assertion below
# unsatisfiable for every lane after the first, and capping the factory at one concurrent lane.
# Nothing in the process env distinguishes sibling lanes (measured on the harness: every CLAUDE_*
# identifier, $CLAUDE_PID included, is session-scoped), so no per-worktree stamp VALUE could be
# searched for either — a per-worktree key is only ever readable from the tree you are standing in.
# Hence the two-path resolution: read the ambient tree's own stamp first, and fall back to the
# session-wide search only when the cwd is the primary checkout (the harness's between-calls reset),
# where the lane is genuinely unknowable if the session owns more than one tree. The `-eq 1`
# assertion is therefore KEPT, unrelaxed — it now guards only the case where ambiguity is real.
#
# Exit codes are the cause: 0 ⇒ root on stdout; 2 ⇒ NO tree carries this lane's stamp; 3 ⇒ SEVERAL
# do. 2 and 3 have opposite remedies and only 2's was ever printed, which is why this survived five
# reproductions — every debugger was told its worktree was gone (#4661 fold-in).
lane_worktree() {   # print the absolute root of THIS lane's worktree
  common="$(git rev-parse --git-common-dir 2>/dev/null)" || return 2
  case "$common" in /*) ;; *) common="$(pwd -P)/$common" ;; esac
  common="$(cd "$common" && pwd -P)" || return 2   # -P: git answers in PHYSICAL paths, so must we
  # AMBIENT-FIRST. The operands stay independent (#4398): the stamp is durable CONTENT written when
  # the tree was proven, matched against the process env, and the root comes from the durable
  # `worktrees/<name>/gitdir` file — never from `--show-toplevel`, so nothing is compared to its own
  # derivation. A linked tree carrying MY session's stamp is a tree my own opening preflight proved.
  amb="$(git rev-parse --absolute-git-dir 2>/dev/null)"
  [ -n "$amb" ] && amb="$(cd "$amb" && pwd -P)"
  if [ -n "$amb" ] && [ "$amb" != "$common" ] && [ -f "$amb/kampus-lane" ] &&
     [ "$(cat "$amb/kampus-lane")" = "$CLAUDE_CODE_SESSION_ID" ] && [ -f "$amb/gitdir" ]; then
    gd="$(cat "$amb/gitdir")" || return 2                 # "<worktree-root>/.git"
    root="$(cd "${gd%/.git}" 2>/dev/null && pwd -P)" || return 2
    [ -n "$root" ] || return 2
    printf '%s\n' "$root"
    return 0
  fi
  hits=""
  for st in "$common"/worktrees/*/kampus-lane; do   # a retired stamp is `kampus-lane.retired`: no match
    [ -f "$st" ] || continue
    [ "$(cat "$st")" = "$CLAUDE_CODE_SESSION_ID" ] || continue
    gd="$(cat "${st%/kampus-lane}/gitdir")" || return 2   # "<worktree-root>/.git"
    hits="$hits $(cd "${gd%/.git}" && pwd -P)"
  done
  set -- $hits
  if [ "$#" -eq 1 ]; then   # unchanged: exactly one, or REFUSE (fail-closed)
    printf '%s\n' "$1"
    return 0
  fi
  if [ "$#" -eq 0 ]; then
    echo "lane_worktree: ZERO worktrees carry this lane's stamp ($CLAUDE_CODE_SESSION_ID) under $common/worktrees/." >&2
    return 2
  fi
  echo "lane_worktree: AMBIGUOUS — $# worktrees carry this lane's stamp ($CLAUDE_CODE_SESSION_ID): $*" >&2
  return 3
}
wt_preflight() {   # MANDATED before every git commit/push/branch op — fail-closed, re-correcting cwd
  : "${CLAUDE_CODE_SESSION_ID:?wt_preflight FAILED (fail-closed): no session id — no lane identity to verify a worktree against}"
  # CLASSIFY THE AMBIENT TREE FIRST — the lane-identity assertions live here, because this is the
  # only place THESE operands can differ. `$AMB_STAMP` is a file some lane wrote when its worktree
  # was proven; `$CLAUDE_CODE_SESSION_ID` is the process env. After the corrective `cd` below these
  # two agree BY CONSTRUCTION, so re-checking THEM down there would be checking a value against its
  # own derivation — which is exactly what shipped, and why the sibling-tree refusal never printed
  # (#4398). That is a fact about these operands, not about position: the post-`cd` refusal below
  # reads independent operands and does fire.
  AMB_GITDIR="$(git rev-parse --absolute-git-dir 2>/dev/null)"
  AMB_COMMON="$(git rev-parse --git-common-dir 2>/dev/null)"
  case "$AMB_COMMON" in ""|/*) ;; *) AMB_COMMON="$(pwd -P)/$AMB_COMMON" ;; esac
  [ -n "$AMB_COMMON" ] && AMB_COMMON="$(cd "$AMB_COMMON" && pwd -P)"   # -P: compare like for like with git's physical answer
  AMB_STAMP="$(cat "$AMB_GITDIR/kampus-lane" 2>/dev/null)"
  echo "wt_preflight: ambient=$(git rev-parse --show-toplevel 2>/dev/null || echo '<not a repo>') ambient-git-dir=${AMB_GITDIR:-<none>} ambient-stamp=${AMB_STAMP:-<none>} lane=$CLAUDE_CODE_SESSION_ID"
  # THE SIBLING-TREE REFUSAL: cwd sits in a LINKED worktree that is not mine. The primary checkout
  # is the harness's documented reset target and is corrected below; a sibling lane's tree is NOT
  # explained by anything, so stop rather than mutate next to a live lane (#832, #3458/#3580).
  if [ -n "$AMB_GITDIR" ] && [ "$AMB_GITDIR" != "$AMB_COMMON" ] && [ "$AMB_STAMP" != "$CLAUDE_CODE_SESSION_ID" ]; then
    echo "wt_preflight FAILED (fail-closed): cwd is inside worktree $(git rev-parse --show-toplevel), stamped '${AMB_STAMP:-<none>}' — a SIBLING lane's tree, not my lane ($CLAUDE_CODE_SESSION_ID). Refusing to mutate." >&2
    return 1
  fi
  # cwd is my own tree or the PRIMARY checkout (the between-calls reset). Resolve my lane by
  # identity and cd there — the correction. A miss REFUSES, and the two misses get DIFFERENT
  # messages because they have opposite remedies: rc 2 means re-establish a worktree, rc 3 means
  # the cwd was reset to the primary checkout and only the lane itself can say which tree it is.
  # One shared message that explained only rc 2 is what routed five debuggers to the wrong (and
  # dangerous — self-provision, blanket worktree removal) remedy (#4500 AC4).
  WT="$(lane_worktree)"
  case "$?" in
    0) ;;
    3) echo "wt_preflight FAILED (fail-closed): AMBIGUOUS — SEVERAL worktrees carry this lane's stamp ($CLAUDE_CODE_SESSION_ID), listed above. Your worktree is NOT missing: sibling lanes of this same session are stamped too, and from the PRIMARY checkout the lane is unknowable. Re-run the mutation from your own lane's worktree (the root the opening preflight CONFIRMED) instead of re-running the opening preflight, self-provisioning, or removing worktrees. Refusing to mutate." >&2
       return 1 ;;
    *) echo "wt_preflight FAILED (fail-closed): ZERO worktrees carry this lane's stamp ($CLAUDE_CODE_SESSION_ID) — the opening preflight never ran, or its tree is gone. Refusing to mutate." >&2
       return 1 ;;
  esac
  cd "$WT" || { echo "wt_preflight FAILED: cannot cd to worktree root $WT" >&2; return 1; }
  # DEFENCE IN DEPTH — the resolved lane must not BE the primary checkout. This sits after the
  # `cd` and is still a genuine assertion, because its operands do not come from the cwd: it
  # tests `lane_worktree`'s ANSWER with two DIFFERENT plumbing queries whose results coincide
  # only on the primary. `lane_worktree` returns whatever `worktrees/<name>/gitdir` names, so an
  # entry naming the primary root, stamped with this lane, resolves here — and this refuses.
  # Demonstrated firing in PR #4419's review; do not delete it as "true by construction" (#4398).
  RES_GITDIR="$(git rev-parse --absolute-git-dir 2>/dev/null)" || { echo "wt_preflight FAILED (fail-closed): resolved lane $WT is not inside a git repository — refusing to mutate." >&2; return 1; }
  RES_COMMON="$(git rev-parse --git-common-dir 2>/dev/null)"
  case "$RES_COMMON" in /*) ;; *) RES_COMMON="$(pwd -P)/$RES_COMMON" ;; esac
  RES_COMMON="$(cd "$RES_COMMON" && pwd -P)"
  [ "$RES_GITDIR" != "$RES_COMMON" ] || { echo "wt_preflight FAILED (fail-closed): this lane's stamp resolved to the PRIMARY checkout ($WT) — git-dir == common-dir. Refusing to mutate." >&2; return 1; }
  # BEAT — this runs immediately before every git mutation this lane makes, which is exactly what
  # makes it liveness evidence rather than another identity check: a lane doing work leaves a fresh
  # beat, a lane that has stopped stops leaving one. `kp_branch_pin` reads it to tell a sibling lane
  # still building from a finished lane's leftover tree, which the shared session id cannot (#4868).
  kp_lane_beat "$RES_GITDIR"
  echo "wt_preflight OK: mutating my lane at $WT (git-dir $RES_GITDIR)"
}
