#!/usr/bin/env bash
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

# Every file a skill's shell can live in, one absolute path per line: its SKILL.md plus every
# `*.sh` under the skill's own directory — the destination the convention above sends extracted
# blocks to. A validator that greps SKILL.md alone stops guarding the moment a block moves out of
# it, staying green while guarding nothing (#4470); resolving the surface HERE, next to the
# convention that defines it, is what keeps the two in step.
#
# Scoped to the skill's OWN directory on purpose. shared/lib/*.sh is cross-skill, so folding it
# into every skill's surface would let one skill's marker satisfy another skill's per-skill check
# — the same guard-in-text/absent-in-effect defect, reintroduced from the other side. A skill that
# extracts its cycle wiring into the shared lib therefore FAILS these validators, loudly, which is
# the correct direction: per-skill wiring stays per-skill, or the validator is updated deliberately.
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
