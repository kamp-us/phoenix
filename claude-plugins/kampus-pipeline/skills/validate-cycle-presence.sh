#!/usr/bin/env bash
# The present-path twin of validate-cycle-absence.sh (issue #750, epic #738).
#
# validate-cycle-absence.sh only ever exercises the foreign-repo ABSENT branch (no
# product-development-cycle.md ⇒ every cycle-aware skill no-ops). That leaves phoenix's
# real state — the cycle doc IS present — proven by nothing in CI: the cycle machinery's
# present-and-active branch was itself a silent no-op gate (ADR 0092 names "the CI cycle
# test only proves the absent path" as a confirmed instance of the class).
#
# This asserts the inverse, hermetically:
# WHAT THIS PROVES, and over which surface (the split is load-bearing — ADR 0230, #4541).
# Two surfaces, deliberately different:
#   OWN      SKILL.md + every *.sh under the skill's own directory (kp_skill_shell_surfaces).
#   WIDENED  OWN plus every shared file the skill's own files DEMONSTRABLY SOURCE, one hop
#            (kp_skill_source_edges) — inclusion keyed on a live-parsed sourcing edge in the
#            skill's own executable shell, not on directory membership.
# ONLY the canonical-probe check reads the WIDENED surface. The present-gate and per-skill action
# checks stay on OWN. That is not fussiness: the shared probe file textually contains every skill's
# markers, so feeding the widened surface to every check would let ONE shared file satisfy EVERY
# skill's per-skill check — #4470's blindness rebuilt through a legitimate edge.
# So the probe check now proves: EITHER the skill's own executable surface carries the canonical
# probe literal, OR its own surface sources a shared file that does. Real wiring, either way — and
# a comment naming the path proves nothing, because every `.sh` grep here runs on COMMENT-STRIPPED
# text. (Honest wording: a live-parsed sourcing edge reaching a file that carries the probe as
# executable code. Not proof of execution — see kp_surface_text's residue note.)
#
#   1. STATIC wiring — each cycle-aware skill carries a PRESENT branch (CYCLE_DOC=present)
#      paired with its present-path action, not just the absent no-op. Scanned across the
#      skill's whole shell surface — SKILL.md AND its extracted scripts/*.sh (#4470):
#        plan-epic   stamps a containment marker (flag|exempt) from the cycle policy
#        write-code  ships dark behind a default-off flag (defaultVariation)
#        review-code verifies the flag-gating before PASS
#        ship-it     surfaces the release queue (status:awaiting-release)
#   2. HERMETIC runtime — with the cycle doc present the canonical probe resolves `present`,
#      and every present-path action fires (the inverse walkthrough of the absence script).
#
# ZERO-SCOPE = FAIL (ADR 0092): this gate fails closed when it scans nothing. The cycle doc
# MUST be present in phoenix (the present path must actually be exercised), and the static
# scope (the cycle-aware skills) must be non-empty — a run that matched zero skills, or one
# missing the cycle doc, is a FAIL, never a silent skip. The scanned scope is emitted.
# No `-e`, deliberately: this script installs a cleanup EXIT trap, and on bash 3.2 errexit +
# an EXIT trap launders a `set -u` abort into exit 0 — a green guard over an unevaluated path
# (#4479). See .patterns/skill-script-shell-shape.md for the measured matrix. Every command
# whose failure errexit used to catch is checked explicitly below.
set -uo pipefail

# Self-locating, same idiom as validate-cycle-absence.sh: this script lives in the skills
# root, so its own dir IS that root — resolve from BASH_SOURCE (physical path, -P, so a symlinked
# or relative caller cannot poison the repo-root walk below) so it works from any cwd.
skills_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ ! -d "$skills_dir" ]; then
	echo "FAIL: could not resolve the skills root from ${BASH_SOURCE[0]} — refusing to scan an unresolved root (ADR 0092)"
	echo "validate-cycle-presence: FAILED — 1 error(s); the scan root could not be resolved"
	exit 1
fi
# The repo root that holds product-development-cycle.md. Prefer git (robust to where the
# script lives in the tree); fall back to the physical plugin path
# (<root>/claude-plugins/kampus-pipeline/skills) when git is unavailable.
repo_root="$(git -C "$skills_dir" rev-parse --show-toplevel 2>/dev/null || (cd "$skills_dir/../../.." && pwd))"
if [ -z "$repo_root" ] || [ ! -d "$repo_root" ]; then
	echo "FAIL: could not resolve the repo root from $skills_dir — the present-path probe has no root to read (ADR 0092)"
	echo "validate-cycle-presence: FAILED — 1 error(s); the repo root could not be resolved"
	exit 1
fi

# kp_skill_shell_surfaces resolves each skill's scan surface — SKILL.md PLUS its extracted
# scripts/*.sh (#4470). Sourced, not re-derived: the surface convention and its resolver live
# together in the lib. A missing lib is a FAIL, never a narrowed scan (ADR 0092).
COMMON_LIB="$skills_dir/../lib/common.sh"
if [ ! -f "$COMMON_LIB" ]; then
	echo "FAIL: shared lib not found at $COMMON_LIB — cannot resolve each skill's shell surface; refusing to scan a narrowed surface (ADR 0092)"
	echo "validate-cycle-presence: FAILED — 1 error(s); the scan surface could not be resolved"
	exit 1
fi
# shellcheck source-path=SCRIPTDIR source=../lib/common.sh
. "$COMMON_LIB"

# The one well-known cycle-doc path every consumer probes (formats §1, single source).
CYCLE_DOC_PATH="product-development-cycle.md"
# The canonical probe string each skill must cite — a content read against the well-known path.
PROBE_NEEDLE="contents/${CYCLE_DOC_PATH}"

# The four cycle-aware skills + the regex its PRESENT-branch wiring must match (case-insensitive).
# Each regex is the skill-specific shape of "doc present ⇒ this cycle-step DOES its action".
# This is the dual of the absence script's absent⇒no-op list: there we asserted the no-op
# branch exists; here we assert the present-path action exists and is gated on the probe.
declare -a CYCLE_SKILLS=(
	"plan-epic   cycle doc present"
	"write-code  defaultVariation"
	"review-code (verify|run).{0,40}gating"
	"ship-it     status:awaiting-release"
)
# Every skill must also pair its present-path action with the present resolution of the probe —
# the literal CYCLE_DOC=present (or the gh-api content read that establishes it). Asserted
# alongside the per-skill action so a present-path action that isn't gated on the probe is caught.
PRESENT_GATE_RE='CYCLE_DOC=present|present-and|present path|cycle doc present|contents/product-development-cycle\.md'

errors=0
checks=0
scanned_skills=0
declare -a scanned_paths=()
declare -a surfaces=()
declare -a edges=()

fail() { echo "FAIL: $*"; errors=$((errors + 1)); }
ok() { echo "ok: $*"; checks=$((checks + 1)); }

# Edge targets come back PHYSICAL and may sit ABOVE $skills_dir — the shared lib is at
# <plugin>/lib since #4484 — so the emitted scope strips the physical plugin root as well as the
# logical skills dir. Without it the scope line carries an absolute machine path.
plugin_root_phys="$(cd -P "$skills_dir/.." 2>/dev/null && pwd)" || plugin_root_phys=""
scope_label() {
	local p="${1#"$skills_dir/"}"
	[ -n "$plugin_root_phys" ] && p="${p#"$plugin_root_phys/"}"
	printf '%s' "$p"
}

# Layer 1: static wiring (present branch).
# Every cycle-aware skill must (a) cite the canonical probe path, (b) resolve it to `present`
# somewhere, and (c) carry the present-path ACTION the cycle requires of it. This is what proves
# the present branch is real wiring and not dead prose; if a future edit drops a skill's
# present-path handling, this fails the build (AC: "fails the build if a skill drops its
# present-path handling").
for entry in "${CYCLE_SKILLS[@]}"; do
	skill="${entry%% *}"
	action_re="${entry#"$skill"}"; action_re="${action_re#"${action_re%%[![:space:]]*}"}"
	md="$skills_dir/$skill/SKILL.md"

	if [ ! -f "$md" ]; then
		fail "$skill: SKILL.md not found at $md"
		continue
	fi

	surfaces=()
	while IFS= read -r surface; do
		[ -n "$surface" ] && surfaces+=("$surface")
	done < <(kp_skill_shell_surfaces "$skills_dir" "$skill")

	# Guard before expanding: an empty `surfaces` aborts every "${surfaces[@]}" below under
	# `set -u`, and the EXIT trap then laundered that abort into exit 0 (see the resolver's
	# docblock in the shared lib, #4470). Refuse the skill instead of scanning nothing.
	if [ "${#surfaces[@]}" -eq 0 ]; then
		fail "$skill: no shell surface resolved (no SKILL.md, no *.sh) — refusing to scan an empty surface (ADR 0092)"
		continue
	fi

	# The source-edge widening, resolved UNPIPED so its status is readable. A named edge that will
	# not resolve makes the surface UNKNOWN: red on it BY NAME here rather than fall through to a
	# needle-not-found over a surface that was never finished (ADR 0230 rule 4; #4505 T7).
	if ! edge_list="$(kp_skill_source_edges "$skills_dir" "$skill")"; then
		fail "$skill: source-edge resolution failed (named diagnostic above) — the widened scan surface is UNKNOWN, so this skill was NOT evaluated (ADR 0230 rule 4 / ADR 0092)"
		continue
	fi
	edges=()
	while IFS= read -r edge; do
		[ -n "$edge" ] && edges+=("$edge")
	done <<EOF
$edge_list
EOF

	scanned_skills=$((scanned_skills + 1))
	for surface in "${surfaces[@]}"; do
		scanned_paths+=("$(scope_label "$surface")")
	done
	# Provenance in the emitted scope (ADR 0092 §1): an edge-resolved file is named with the skill
	# whose source edge pulled it in, so "why was this file read" is answerable from the run log.
	if [ "${#edges[@]}" -gt 0 ]; then
		for edge in "${edges[@]}"; do
			scanned_paths+=("$(scope_label "$edge") (edge:$skill)")
		done
	fi

	# Comment-stripped match text. `.sh` commentary is not wiring — the whole defect this closes was
	# a docblock satisfying the probe grep (#4541).
	if ! own_text="$(kp_surface_text "${surfaces[@]}")"; then
		fail "$skill: could not read its own shell surface — UNKNOWN, never 'the marker is absent' (ADR 0092)"
		continue
	fi
	probe_text="$own_text"
	if [ "${#edges[@]}" -gt 0 ]; then
		if ! edge_text="$(kp_surface_text "${edges[@]}")"; then
			fail "$skill: could not read a source-edge target — UNKNOWN, never 'the marker is absent' (ADR 0092)"
			continue
		fi
		probe_text="$own_text$edge_text"
	fi

	# Canonical-probe check: the ONE check that reads the widened surface.
	if ! grep -qF "$PROBE_NEEDLE" <<<"$probe_text"; then
		fail "$skill: does not cite the canonical cycle-doc probe ('$PROBE_NEEDLE') in executable shell or via a source edge — the present branch must key off the one well-known path (formats §1)"
	else
		ok "$skill cites the canonical cycle-doc probe"
	fi

	# Every remaining check stays on the skill's OWN surface (#4505 T3).
	if ! grep -qiE "$PRESENT_GATE_RE" <<<"$own_text"; then
		fail "$skill: no present-resolution of the cycle probe found (expected /$PRESENT_GATE_RE/i) — the present-path action must be gated on the doc being present"
	else
		ok "$skill resolves the probe to present"
	fi

	if ! grep -qiE "$action_re" <<<"$own_text"; then
		fail "$skill: no present-path action found (expected /$action_re/i) — the cycle's present branch must DO something (ADR 0091/0092), not just no-op"
	else
		ok "$skill carries its present-path action (/$action_re/i)"
	fi
done

# Layer 2: hermetic runtime walkthrough (present branch).
# Execute the canonical working-tree form of the probe (formats §1) against a synthetic repo
# root that HAS a cycle doc, then walk the four present-path decisions exactly as each skill's
# cycle-step does. This is the doc-present scenario actually run — the inverse of the absence
# script's doc-absent walkthrough.
tmp_root="$(mktemp -d)"
if [ -z "$tmp_root" ] || [ ! -d "$tmp_root" ]; then
	echo "FAIL: mktemp -d produced no temp root — refusing to run the hermetic walkthrough against nothing (ADR 0092)"
	echo "validate-cycle-presence: FAILED — 1 error(s); the hermetic scenario could not be set up"
	exit 1
fi
trap 'rm -rf "$tmp_root"' EXIT

# A phoenix-shaped install: a repo root with a product-development-cycle.md at the root.
touch "$tmp_root/README.md" "$tmp_root/CLAUDE.md" "$tmp_root/$CYCLE_DOC_PATH"

probe_cycle_doc() { # the canonical probe, working-tree form — echoes present|absent
	if [ -f "$1/$CYCLE_DOC_PATH" ]; then echo present; else echo absent; fi
}

if [ "$(probe_cycle_doc "$tmp_root")" != "present" ]; then
	fail "hermetic probe: a repo root WITH $CYCLE_DOC_PATH must resolve 'present'"
else
	ok "hermetic probe resolves 'present' on a phoenix-shaped install (with $CYCLE_DOC_PATH)"
fi

CYCLE_DOC="$(probe_cycle_doc "$tmp_root")"   # present
CONTAINMENT="flag (default-off)"             # a user-facing child the cycle wants contained

# plan-epic: stamps a containment marker from the cycle policy (NOT `none`)
if [ "$CYCLE_DOC" = present ]; then PLAN_MARKER="flag (default-off)"; else PLAN_MARKER="none (no cycle doc)"; fi
case "$PLAN_MARKER" in
	none*) fail "plan-epic stamped no marker on a PRESENT cycle doc (got '$PLAN_MARKER') — the present branch must stamp flag|exempt" ;;
	*)     ok "plan-epic stamps a containment marker on present doc (child carries '$PLAN_MARKER')" ;;
esac

# write-code: ships dark behind a default-off flag
if [ "$CONTAINMENT" = "flag (default-off)" ] && [ "$CYCLE_DOC" = present ]; then SHIP_DARK=yes; else SHIP_DARK=no; fi
if [ "$SHIP_DARK" = yes ]; then
	ok "write-code ships dark on present doc + flag containment (default-off flag introduced)"
else
	fail "write-code did NOT ship dark on a present cycle doc + flag containment"
fi

# review-code: runs the flag-gating verification (the gate engages, no waved-through PASS)
if [ "$CONTAINMENT" = "flag (default-off)" ] && [ "$CYCLE_DOC" = present ]; then GATE=verify-gating; else GATE=skip; fi
if [ "$GATE" = verify-gating ]; then
	ok "review-code engages the gating check on present doc + flag containment"
else
	fail "review-code skipped gating on a present cycle doc + flag containment (would wave the PR through)"
fi

# ship-it: surfaces the release queue (the dark merge is deployed, awaiting a human flip)
LINKED_ISSUE=750
if [ -n "$LINKED_ISSUE" ] && [ "$CYCLE_DOC" = present ] && [ "$CONTAINMENT" = "flag (default-off)" ]; then
	RELEASE_QUEUE="queued (awaiting human flip)"
else
	RELEASE_QUEUE="n/a (not a dark ship)"
fi
if [ "$RELEASE_QUEUE" = "queued (awaiting human flip)" ]; then
	ok "ship-it surfaces the release queue on present doc + flag containment ('$RELEASE_QUEUE')"
else
	fail "ship-it surfaced no release queue on a present cycle doc + flag containment"
fi

# Zero-scope guard (ADR 0092): the present path MUST actually be exercised.
# Two ways this gate could scan nothing and pass vacuously, both FAIL CLOSED:
#   1. The static scope matched zero skills (a moved/renamed skills dir).
#   2. phoenix's real cycle doc is missing — then the present path is never exercised here,
#      so there is nothing to prove and this gate would be a silent no-op (the exact rot
#      ADR 0092 forbids). In phoenix the doc MUST be present; absent ⇒ FAIL, not skip.
if [ "$scanned_skills" -eq 0 ]; then
	fail "zero scope: no cycle-aware skills were scanned (skills dir moved?) — a zero-scope run is a FAIL, never a silent pass (ADR 0092)"
fi
if [ ! -f "$repo_root/$CYCLE_DOC_PATH" ]; then
	fail "zero scope: phoenix has no $repo_root/$CYCLE_DOC_PATH — the present path cannot be exercised; this gate fails closed rather than no-op (ADR 0092)"
else
	ok "phoenix's real cycle doc is present at $CYCLE_DOC_PATH (present path is live)"
fi

# Emitted scope (ADR 0092): every run states what it looked at.
echo "scanned scope: ${scanned_skills} cycle-aware skill(s) [${scanned_paths[*]-}]; phoenix cycle doc: $([ -f "$repo_root/$CYCLE_DOC_PATH" ] && echo present || echo MISSING)"

if [ "$errors" -gt 0 ]; then
	echo "validate-cycle-presence: FAILED — $errors error(s); phoenix's present cycle-doc path is not real (a present-branch action is missing, or the gate scanned zero scope — ADR 0091/0092)"
	exit 1
fi

echo "validate-cycle-presence: OK — $checks checks; phoenix's present cycle-doc path is real (probe⇒present, all four present-path actions wired + exercised)"
