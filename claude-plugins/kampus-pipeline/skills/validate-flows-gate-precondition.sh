#!/usr/bin/env bash
# Make the #713 dependency a FIRED gate, not a TODO comment (issue #751, epic #738).
#
# The authed write-flow Playwright lane (`flows`: vote / save / submit) must stay
# NON-BLOCKING (`continue-on-error: true`) until #713's write-flow state-isolation
# lands — flipping it blocking while the preview still fails late under serial load
# would trade the silent-no-op gate for a FLAKY hard-block (the exact anti-pattern
# this epic exists to avoid). This guard enforces that invariant statically:
#
#   FLOWS_GATE_PRECONDITION: pending  ⟺  the `flows` step is continue-on-error
#   FLOWS_GATE_PRECONDITION: met      ⟺  the `flows` run is folded into the BLOCKING
#                                        step (no continue-on-error on a `flows` step)
#
# The marker in .github/workflows/ci.yml is the SINGLE SOURCE the flip is gated on.
# A human/agent flips the lane blocking ONLY once #713 closes by setting the marker to
# `met` and moving the run into the blocking step; this guard then re-checks the new
# shape. A premature flip (marker still `pending` but the `flows` step lost its
# `continue-on-error`, or vice-versa) fails the build here instead of silently shipping
# a flaky block — so the dependency is recorded and enforced, never just narrated.
#
# DETERMINISTIC BY DESIGN: the authoritative check is purely static (parse ci.yml), so
# it never flakes and needs no network in CI. When `gh` is present AND authed it ALSO
# cross-checks #713's live open/closed state as an ADVISORY consistency signal — but a
# missing/unauthed `gh`, or an API hiccup, is a clean skip, never a build failure. The
# static marker is the source of truth; the live check only warns on drift.
#
# Same self-locating + Bash 3.2 idiom as validate-gate-path-drift.sh.
set -euo pipefail

skills_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd "$skills_dir/../../.." && pwd -P)"

CI_YML="$repo_root/.github/workflows/ci.yml"
# The cross-epic precondition this flip is gated on (epic #738 records it as
# `#751 requires: #713`); kept here so the guard's diagnostics name the blocker.
PRECONDITION_ISSUE=713

errors=0
checks=0

fail() { echo "FAIL: $*"; errors=$((errors + 1)); }
ok()   { echo "ok: $*";   checks=$((checks + 1)); }
warn() { echo "warn: $*"; }

if [ ! -f "$CI_YML" ]; then
	fail ".github/workflows/ci.yml not found at $CI_YML — cannot verify the flows-gate precondition"
	echo "validate-flows-gate-precondition: FAILED — $errors error(s)"
	exit 1
fi

# ── The recorded precondition marker (single source of truth) ────────────────
# Exactly one `FLOWS_GATE_PRECONDITION: <state>` line, state ∈ {pending, met}.
MARKER_LINES=$(grep -cE '^[[:space:]]*#?[[:space:]]*FLOWS_GATE_PRECONDITION:[[:space:]]' "$CI_YML" || true)
if [ "$MARKER_LINES" = "0" ]; then
	fail "no FLOWS_GATE_PRECONDITION marker in ci.yml — the #${PRECONDITION_ISSUE} flip-gate must be recorded as a marker, not an ad-hoc TODO (issue #751)"
	echo "validate-flows-gate-precondition: FAILED — $errors error(s)"
	exit 1
fi
if [ "$MARKER_LINES" != "1" ]; then
	fail "expected exactly one FLOWS_GATE_PRECONDITION marker in ci.yml, found $MARKER_LINES — a single source of truth, never a divergent set"
fi

STATE=$(grep -E '^[[:space:]]*#?[[:space:]]*FLOWS_GATE_PRECONDITION:[[:space:]]' "$CI_YML" | head -n1 \
	| sed -E 's/.*FLOWS_GATE_PRECONDITION:[[:space:]]*([A-Za-z]+).*/\1/')
case "$STATE" in
	pending|met) ok "FLOWS_GATE_PRECONDITION marker present (state: $STATE)" ;;
	*)
		fail "FLOWS_GATE_PRECONDITION has an unknown state '$STATE' — must be 'pending' (gated on #${PRECONDITION_ISSUE}) or 'met' (flipped blocking)"
		echo "validate-flows-gate-precondition: FAILED — $errors error(s)"
		exit 1
		;;
esac

# ── The observed CI shape: is the `flows` run still non-blocking? ────────────
# A `flows` lane is non-blocking iff its step carries `continue-on-error: true`. We
# detect the flows step's continue-on-error by locating the `--project flows` RUN ARG
# (not a comment mentioning it) and reporting the SAME step's continue-on-error state.
# Comment lines (first non-space char `#`) are skipped so prose that names
# `--project flows` can't be mistaken for the real run arg. The shape is small and
# stable, so a focused awk over the step block is precise enough and toolchain-free.
#
# `flows_nonblocking=yes` ⇒ the lane cannot wedge merge (signal-only).
# `flows_nonblocking=no`  ⇒ the lane gates ci-required (blocking).
flows_nonblocking=$(awk '
	{ stripped=$0; sub(/^[[:space:]]+/, "", stripped) }   # leading-ws-stripped copy for the comment test
	stripped ~ /^#/ { next }                              # skip comments (prose may name --project flows)
	/^[[:space:]]*-[[:space:]]*name:/ { ce="no" }         # new step → reset
	/continue-on-error:[[:space:]]*true/ { ce="yes" }
	/--project[[:space:]]+flows/ {
		print ce; found=1; exit                           # real run arg targeting flows → report its CE state
	}
	END { if (!found) print "absent" }
' "$CI_YML")

case "$flows_nonblocking" in
	yes) ok "the flows lane is non-blocking (continue-on-error: true)" ;;
	no)  ok "the flows lane is blocking (no continue-on-error on its run step)" ;;
	absent)
		fail "no '--project flows' run step found in ci.yml — the write-flow lane must exist to be gated"
		echo "validate-flows-gate-precondition: FAILED — $errors error(s)"
		exit 1
		;;
esac

# ── The invariant: marker state ⟺ observed shape ─────────────────────────────
# pending  ⇒ flows MUST be non-blocking (don't flip while #713 is open).
# met      ⇒ flows MUST be blocking (the marker claims #713 landed; back it with the shape).
if [ "$STATE" = pending ] && [ "$flows_nonblocking" != yes ]; then
	fail "FLOWS_GATE_PRECONDITION is 'pending' (gated on #${PRECONDITION_ISSUE}) but the flows lane is NOT continue-on-error — a premature flip to a flaky block. Keep it non-blocking until #${PRECONDITION_ISSUE} lands, then set the marker to 'met' (issue #751)."
elif [ "$STATE" = met ] && [ "$flows_nonblocking" != no ]; then
	fail "FLOWS_GATE_PRECONDITION is 'met' but the flows lane is STILL continue-on-error — the marker claims #${PRECONDITION_ISSUE} landed, so fold the flows run into the blocking step and drop continue-on-error (issue #751)."
else
	ok "precondition marker and CI shape agree (state=$STATE ⟺ flows non-blocking=$flows_nonblocking)"
fi

# ── Advisory live cross-check (never gates) ──────────────────────────────────
# When `gh` is present and authed, compare the marker against #713's actual state. This
# is a drift WARNING only — the static marker remains authoritative, so a missing/unauthed
# gh or an API error is a clean skip, never a build failure (keeps CI deterministic).
if command -v gh >/dev/null 2>&1; then
	REPO="${CLAUDE_PIPELINE_REPO:-kamp-us/phoenix}"
	live_state=$(gh api "repos/$REPO/issues/$PRECONDITION_ISSUE" --jq '.state' 2>/dev/null || true)
	case "$live_state" in
		open)
			if [ "$STATE" = met ]; then
				warn "marker says 'met' but #${PRECONDITION_ISSUE} is still OPEN — verify the state-isolation actually landed before keeping the lane blocking"
			else
				ok "advisory: #${PRECONDITION_ISSUE} is open and the marker is 'pending' (consistent)"
			fi
			;;
		closed)
			if [ "$STATE" = pending ]; then
				warn "#${PRECONDITION_ISSUE} is CLOSED — the flip-blocking precondition may now be met; consider setting FLOWS_GATE_PRECONDITION to 'met' and folding flows into the blocking step (issue #751)"
			else
				ok "advisory: #${PRECONDITION_ISSUE} is closed and the marker is 'met' (consistent)"
			fi
			;;
		*) warn "advisory live check skipped (could not read #${PRECONDITION_ISSUE} state; static marker is authoritative)" ;;
	esac
else
	warn "advisory live check skipped (gh not available; static marker is authoritative)"
fi

# ── Verdict ──────────────────────────────────────────────────────────────────
if [ "$errors" -gt 0 ]; then
	echo "validate-flows-gate-precondition: FAILED — $errors error(s); the #${PRECONDITION_ISSUE}-gated flows-blocking flip invariant is broken (issue #751)"
	exit 1
fi

echo "validate-flows-gate-precondition: OK — $checks checks; the flows-blocking flip stays correctly gated on #${PRECONDITION_ISSUE}"
