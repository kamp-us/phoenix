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
#   2. HERMETIC runtime — run the canonical working-tree probe against a temp repo root
#      with no cycle doc, assert it resolves `absent` and the no-op default holds. This is
#      the executable scenario walkthrough of the doc-absent branch (issue #605, epic #595).
#
# This guards the COMPOSITION of #597 (the hook) + #598–#601 (the four skill changes): if a
# future edit drops the probe or flips an absent branch to a hardcoded flag, this fails the
# build instead of silently breaking portability.
set -euo pipefail

# Same self-locating idiom as validate-skills.sh: this script lives in .claude/skills/, so
# its own dir IS the skills root — resolve from BASH_SOURCE so it works from any cwd.
skills_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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

fail() { echo "FAIL: $*"; errors=$((errors + 1)); }
ok() { echo "ok: $*"; checks=$((checks + 1)); }

# ── Layer 1: static wiring ───────────────────────────────────────────────────
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

	if ! grep -qF "$PROBE_NEEDLE" "$md"; then
		fail "$skill: does not cite the canonical cycle-doc probe ('$PROBE_NEEDLE') — every cycle-step must branch on the one well-known path (formats §1)"
	else
		ok "$skill cites the canonical absence-probe"
	fi

	if ! grep -qiE "$noop_re" "$md"; then
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
	md="$skills_dir/$skill/SKILL.md"
	[ -f "$md" ] || continue
	if grep -qiE 'cycle (doc|step) (is )?(always|unconditionally)' "$md"; then
		fail "$skill: appears to assume the cycle doc is always present — graceful absence requires the probe to gate it"
	fi
done

# ── Layer 2: hermetic runtime walkthrough ────────────────────────────────────
# Execute the canonical working-tree form of the probe (formats §1: a skill on a local tree
# may substitute `test -f product-development-cycle.md` for the gh api read — same probe,
# same well-known path, same absent⇒no-op rule) against a synthetic repo root that has NO
# cycle doc. This is the doc-absent scenario actually run, not just asserted in prose.
tmp_root="$(mktemp -d)"
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

# ── Verdict ──────────────────────────────────────────────────────────────────
if [ "$errors" -gt 0 ]; then
	echo "validate-cycle-absence: FAILED — $errors error(s); the graceful-absence guarantee (ADR 0062 / 0083) is broken"
	exit 1
fi

echo "validate-cycle-absence: OK — $checks checks; cycle-aware skills no-op gracefully with no $CYCLE_DOC_PATH"
