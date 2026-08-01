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
  echo "wt_preflight OK: mutating my lane at $WT (git-dir $RES_GITDIR)"
}
