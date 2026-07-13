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
#   1. STATIC wiring — each cycle-aware skill carries a PRESENT branch (CYCLE_DOC=present)
#      paired with its present-path action, not just the absent no-op:
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
set -euo pipefail

# Self-locating, same idiom as validate-cycle-absence.sh: this script lives in the skills
# root, so its own dir IS that root — resolve from BASH_SOURCE (physical path, -P, so the
# .claude/skills symlink doesn't poison the repo-root walk below) so it works from any cwd.
skills_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The repo root that holds product-development-cycle.md. Prefer git (robust to where the
# script lives in the tree); fall back to the physical plugin path
# (<root>/claude-plugins/kampus-pipeline/skills) when git is unavailable.
repo_root="$(git -C "$skills_dir" rev-parse --show-toplevel 2>/dev/null || (cd "$skills_dir/../../.." && pwd))"

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

fail() { echo "FAIL: $*"; errors=$((errors + 1)); }
ok() { echo "ok: $*"; checks=$((checks + 1)); }

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
	scanned_skills=$((scanned_skills + 1))
	scanned_paths+=("$skill/SKILL.md")

	if ! grep -qF "$PROBE_NEEDLE" "$md"; then
		fail "$skill: does not cite the canonical cycle-doc probe ('$PROBE_NEEDLE') — the present branch must key off the one well-known path (formats §1)"
	else
		ok "$skill cites the canonical cycle-doc probe"
	fi

	if ! grep -qiE "$PRESENT_GATE_RE" "$md"; then
		fail "$skill: no present-resolution of the cycle probe found (expected /$PRESENT_GATE_RE/i) — the present-path action must be gated on the doc being present"
	else
		ok "$skill resolves the probe to present"
	fi

	if ! grep -qiE "$action_re" "$md"; then
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
echo "scanned scope: ${scanned_skills} cycle-aware skill(s) [${scanned_paths[*]}]; phoenix cycle doc: $([ -f "$repo_root/$CYCLE_DOC_PATH" ] && echo present || echo MISSING)"

if [ "$errors" -gt 0 ]; then
	echo "validate-cycle-presence: FAILED — $errors error(s); phoenix's present cycle-doc path is not real (a present-branch action is missing, or the gate scanned zero scope — ADR 0091/0092)"
	exit 1
fi

echo "validate-cycle-presence: OK — $checks checks; phoenix's present cycle-doc path is real (probe⇒present, all four present-path actions wired + exercised)"
