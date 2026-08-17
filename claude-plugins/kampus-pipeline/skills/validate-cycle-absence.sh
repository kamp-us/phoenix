#!/usr/bin/env bash
# Portability safety net: assert the foreign-install / graceful-absence guarantee that
# ADR 0062 (repo-as-config portability) and ADR 0083 §2 (agents deploy / humans release)
# promise — with NO product-development-cycle.md at the repo root, every cycle-aware skill
# no-ops cleanly:
#
#   plan-epic   stamps no flag marker  (children carry `none`/omit the Containment line)
#   write-code  introduces no flag     (ships the change normally, no dark-ship)
#   review-code runs no gating check   (no false FAIL on a non-flag PR)
#   ship-it     surfaces no release    (merges with no release-queue step)
#
# Two layers, both runnable in CI/locally (see .github/workflows/ci.yml):
#   1. STATIC wiring — each of the four skills cites THE single canonical absence-probe
#      (the well-known repo path `product-development-cycle.md`, formats §1) and pairs it
#      with an absent⇒no-op branch. No skill hardcodes a flag or assumes the doc exists.
#      Scanned across the skill's whole shell surface — SKILL.md AND its extracted
#      scripts/*.sh (#4470) — so moving a block out of SKILL.md cannot disarm this.
#      TWO SURFACES, and the split is load-bearing (ADR 0230, #4541): only the canonical-probe
#      check reads the WIDENED surface (own files + the shared files they demonstrably source,
#      one hop); the absent⇒no-op and hardcoded-flag checks stay on the skill's OWN files. The
#      shared probe file textually carries every skill's absence marker, so widening every check
#      would let one shared file satisfy all four — #4470's blindness through a legitimate edge.
#      Every `.sh` grep here runs on COMMENT-STRIPPED text, so a citation in a docblock proves
#      nothing; the presence twin's docblock carries the full statement of what this proves.
#   2. HERMETIC runtime — run the canonical working-tree probe against a temp repo root
#      with no cycle doc, assert it resolves `absent` and the no-op default holds. This is
#      the executable scenario walkthrough of the doc-absent branch (issue #605, epic #595).
#
# This guards the COMPOSITION of #597 (the hook) + #598–#601 (the four skill changes): if a
# future edit drops the probe or flips an absent branch to a hardcoded flag, this fails the
# build instead of silently breaking portability.
# No `-e`, deliberately: this script installs a cleanup EXIT trap, and on bash 3.2 errexit +
# an EXIT trap launders a `set -u` abort into exit 0 — a green guard over an unevaluated path
# (#4479). See .patterns/skill-script-shell-shape.md for the measured matrix. Every command
# whose failure errexit used to catch is checked explicitly below.
set -uo pipefail

# Same self-locating idiom as the presence twin: this script lives in the skills root, so its own
# dir IS that root — resolve from BASH_SOURCE, PHYSICALLY (`cd -P`), so any symlinked or relative
# caller still lands on the real skills root.
#
# What `-P` actually buys is the EMITTED SCOPE, not the allowlist. Measured: a logical-`cd` variant
# through a symlinked caller still exits 0, because `kp_skill_source_edges` resolves its own roots AND its
# edge targets with `cd -P`, so that comparison is physical on both sides whatever it is handed.
# What breaks under a logical root is `scope_label`'s prefix strip below: the prefix misses,
# and every edge-resolved file is printed as a full absolute machine path instead of
# `shared/scripts/cycle-doc-probe.sh (edge:plan-epic)`. That is an ADR 0092 §1 emission defect —
# "what did this run look at" stops being answerable in repo terms — and a leak surface, since an
# absolute path carries the runner's checkout layout into a CI log (#4505 T7).
skills_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ ! -d "$skills_dir" ]; then
	echo "FAIL: could not resolve the skills root from ${BASH_SOURCE[0]} — refusing to scan an unresolved root (ADR 0092)"
	echo "validate-cycle-absence: FAILED — 1 error(s); the scan root could not be resolved"
	exit 1
fi

# kp_skill_shell_surfaces resolves each skill's scan surface — SKILL.md PLUS its extracted
# scripts/*.sh (#4470). Sourced, not re-derived: the surface convention and its resolver live
# together in the lib. A missing lib is a FAIL, never a narrowed scan (ADR 0092).
COMMON_LIB="$skills_dir/../lib/common.sh"
if [ ! -f "$COMMON_LIB" ]; then
	echo "FAIL: shared lib not found at $COMMON_LIB — cannot resolve each skill's shell surface; refusing to scan a narrowed surface (ADR 0092)"
	echo "validate-cycle-absence: FAILED — 1 error(s); the scan surface could not be resolved"
	exit 1
fi
# shellcheck source-path=SCRIPTDIR source=../lib/common.sh
. "$COMMON_LIB"

# The one well-known cycle-doc path every consumer probes (formats §1, single source).
CYCLE_DOC_PATH="product-development-cycle.md"
# The canonical probe string each skill must cite — a content read against the well-known
# path. Anchored on the literal path so a renamed/forked probe is caught.
PROBE_NEEDLE="contents/${CYCLE_DOC_PATH}"

# The four cycle-aware skills + the no-op term each uses for its absent-branch behavior.
# Format: "<skill> <regex the skill's absent⇒no-op wiring must match (case-insensitive)>".
# Each regex is the skill-specific shape of "absent ⇒ this cycle-step does nothing".
declare -a CYCLE_SKILLS=(
	"plan-epic   no-?op"
	"write-code  CYCLE_DOC=absent"
	"review-code CYCLE_DOC=absent"
	"ship-it     graceful absence"
)

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

# Layer 1: static wiring.
# Every cycle-aware skill must (a) cite the single canonical probe path and (b) pair it
# with an absent⇒no-op branch. Proves AC: "the canonical absence-probe is the one each
# skill branches on — no skill hardcodes flags or assumes the doc exists."
for entry in "${CYCLE_SKILLS[@]}"; do
	skill="${entry%% *}"
	noop_re="${entry#"$skill"}"; noop_re="${noop_re#"${noop_re%%[![:space:]]*}"}"
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
	# `set -u`, and the EXIT trap then launders that abort into exit 0 (see the resolver's
	# docblock in the shared lib, #4470). Refuse the skill instead of scanning nothing.
	if [ "${#surfaces[@]}" -eq 0 ]; then
		fail "$skill: no shell surface resolved (no SKILL.md, no *.sh) — refusing to scan an empty surface (ADR 0092)"
		continue
	fi

	# The source-edge widening, resolved UNPIPED so its status is readable. A named edge that will
	# not resolve makes the surface UNKNOWN: red BY NAME rather than emit a confusing
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
		fail "$skill: does not cite the canonical cycle-doc probe ('$PROBE_NEEDLE') in executable shell or via a source edge — every cycle-step must branch on the one well-known path (formats §1)"
	else
		ok "$skill cites the canonical absence-probe"
	fi

	# The absent⇒no-op branch stays on the skill's OWN surface (#4505 T3).
	if ! grep -qiE "$noop_re" <<<"$own_text"; then
		fail "$skill: no absent⇒no-op branch found (expected /$noop_re/i) — an absent cycle doc must no-op gracefully (ADR 0062)"
	else
		ok "$skill has an absent⇒no-op branch"
	fi
done

# No cycle-aware skill may hardcode phoenix's flag policy unconditionally. The flag/dark-ship
# mechanics must always sit behind the present-doc branch; a bare default-on flag declaration
# in a skill body would defeat graceful absence. (Heuristic: a skill must not assert the doc
# is present without the probe that establishes it.)
for entry in "${CYCLE_SKILLS[@]}"; do
	skill="${entry%% *}"
	[ -f "$skills_dir/$skill/SKILL.md" ] || continue
	surfaces=()
	while IFS= read -r surface; do
		[ -n "$surface" ] && surfaces+=("$surface")
	done < <(kp_skill_shell_surfaces "$skills_dir" "$skill")
	if [ "${#surfaces[@]}" -eq 0 ]; then
		fail "$skill: no shell surface resolved (no SKILL.md, no *.sh) — refusing to scan an empty surface (ADR 0092)"
		continue
	fi
	# OWN surface, comment-stripped (#4505 T3/T2). This heuristic looks for a skill ASSERTING the
	# doc is always there; widening it to shared files would blame every sourcing skill for one
	# shared file's wording.
	if ! own_text="$(kp_surface_text "${surfaces[@]}")"; then
		fail "$skill: could not read its own shell surface for the hardcoded-flag heuristic — UNKNOWN, never 'clean' (ADR 0092)"
		continue
	fi
	if grep -qiE 'cycle (doc|step) (is )?(always|unconditionally)' <<<"$own_text"; then
		fail "$skill: appears to assume the cycle doc is always present — graceful absence requires the probe to gate it"
	fi
done

# Layer 2: hermetic runtime walkthrough.
# Execute the canonical working-tree form of the probe (formats §1: a skill on a local tree
# may substitute `test -f product-development-cycle.md` for the gh api read — same probe,
# same well-known path, same absent⇒no-op rule) against a synthetic repo root that has NO
# cycle doc. This is the doc-absent scenario actually run, not just asserted in prose.
tmp_root="$(mktemp -d)"
if [ -z "$tmp_root" ] || [ ! -d "$tmp_root" ]; then
	echo "FAIL: mktemp -d produced no temp root — refusing to run the hermetic walkthrough against nothing (ADR 0092)"
	echo "validate-cycle-absence: FAILED — 1 error(s); the hermetic scenario could not be set up"
	exit 1
fi
trap 'rm -rf "$tmp_root"' EXIT

# A foreign install: a repo root with the usual files but no product-development-cycle.md.
touch "$tmp_root/README.md" "$tmp_root/CLAUDE.md"

probe_cycle_doc() { # the canonical probe, working-tree form — echoes present|absent
	if [ -f "$1/$CYCLE_DOC_PATH" ]; then echo present; else echo absent; fi
}

if [ "$(probe_cycle_doc "$tmp_root")" != "absent" ]; then
	fail "hermetic probe: a repo root with no $CYCLE_DOC_PATH must resolve 'absent'"
else
	ok "hermetic probe resolves 'absent' on a foreign install (no $CYCLE_DOC_PATH)"
fi

# Sanity in the other direction: with the doc present the probe flips to 'present', proving
# the probe actually discriminates (an always-'absent' probe would pass the above vacuously).
touch "$tmp_root/$CYCLE_DOC_PATH"
if [ "$(probe_cycle_doc "$tmp_root")" != "present" ]; then
	fail "hermetic probe: a repo root WITH $CYCLE_DOC_PATH must resolve 'present'"
else
	ok "hermetic probe resolves 'present' when the cycle doc exists (discriminating)"
fi
rm -f "$tmp_root/$CYCLE_DOC_PATH"

# Walk the four no-op decisions on the absent branch, exactly as each skill's cycle-step does:
# the dark-ship / marker / gating / release-queue action fires ONLY when the doc is present,
# so on `absent` every one degrades to its safe default. The conditions below mirror the
# guard each skill ships:
#   write-code:  ship dark ONLY when CONTAINMENT==flag && CYCLE_DOC==present
#   review-code: run gating ONLY when CONTAINMENT==flag && CYCLE_DOC==present
#   ship-it:     queue release ONLY when linked-issue && CYCLE_DOC==present && marker==flag
#   plan-epic:   stamp containment ONLY when CYCLE_DOC==present (else child carries `none`)
CYCLE_DOC="$(probe_cycle_doc "$tmp_root")"   # absent
CONTAINMENT="flag (default-off)"             # even a would-be flag child must not ship dark when the doc is absent

# plan-epic: no flag marker stamped
if [ "$CYCLE_DOC" = present ]; then PLAN_MARKER="flag (default-off)"; else PLAN_MARKER="none (no cycle doc)"; fi
case "$PLAN_MARKER" in
	none*) ok "plan-epic stamps no flag marker on absent doc (child carries '$PLAN_MARKER')" ;;
	*)     fail "plan-epic stamped a flag marker on an absent cycle doc ('$PLAN_MARKER')" ;;
esac

# write-code: introduces no flag
if [ "$CONTAINMENT" = "flag (default-off)" ] && [ "$CYCLE_DOC" = present ]; then SHIP_DARK=yes; else SHIP_DARK=no; fi
if [ "$SHIP_DARK" = no ]; then
	ok "write-code introduces no flag on absent doc (ships normally)"
else
	fail "write-code shipped dark on an absent cycle doc"
fi

# review-code: runs no gating check (no false FAIL)
if [ "$CONTAINMENT" = "flag (default-off)" ] && [ "$CYCLE_DOC" = present ]; then GATE=verify-gating; else GATE=skip; fi
if [ "$GATE" = skip ]; then
	ok "review-code skips gating on absent doc (no false FAIL)"
else
	fail "review-code ran a gating check on an absent cycle doc (would false-FAIL)"
fi

# ship-it: merges with no release-queue step
LINKED_ISSUE=602   # even with a linked issue, absent doc ⇒ nothing to release
if [ -n "$LINKED_ISSUE" ] && [ "$CYCLE_DOC" = present ] && [ "$CONTAINMENT" = "flag (default-off)" ]; then
	RELEASE_QUEUE="queued (awaiting human flip)"
else
	RELEASE_QUEUE="n/a (not a dark ship)"
fi
if [ "$RELEASE_QUEUE" = "n/a (not a dark ship)" ]; then
	ok "ship-it surfaces no release queue on absent doc (merges plainly)"
else
	fail "ship-it surfaced a release queue on an absent cycle doc"
fi

# Zero-scope guard (ADR 0092): a run that matched zero cycle-aware skills — a moved or renamed
# skills dir — would sail through layer 2's hermetic walkthrough (which touches no skill) and
# print OK having asserted nothing about the corpus. Fail closed instead.
if [ "$scanned_skills" -eq 0 ]; then
	fail "zero scope: no cycle-aware skills were scanned (skills dir moved?) — a zero-scope run is a FAIL, never a silent pass (ADR 0092)"
fi

# Emitted scope (ADR 0092): every run states what it looked at.
echo "scanned scope: ${scanned_skills} cycle-aware skill(s) [${scanned_paths[*]-}]"

if [ "$errors" -gt 0 ]; then
	echo "validate-cycle-absence: FAILED — $errors error(s); the graceful-absence guarantee (ADR 0062 / 0083) is broken"
	exit 1
fi

echo "validate-cycle-absence: OK — $checks checks; cycle-aware skills no-op gracefully with no $CYCLE_DOC_PATH"
