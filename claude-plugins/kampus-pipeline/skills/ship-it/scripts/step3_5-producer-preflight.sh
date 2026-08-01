#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091
# Producer-presence preflight — does this repo define a run-evidence workflow at all (ADR 0086).
#
# Extracted VERBATIM from ship-it/SKILL.md's Step 3.5 fenced block (epic #4435 phase 1, #4448).
# A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2 (#1929).
#
# DUAL-MODE (ADR 0232) — the why is `.patterns/skill-script-shell-shape.md` § The dual-mode shape.
#   EXECUTED:  bash ./claude-plugins/kampus-pipeline/skills/ship-it/scripts/step3_5-producer-preflight.sh <REPO>
#              stdout ⇒ `HAS_PRODUCER=<n>`, plus the `guard 2 N/A …` line when the count is 0. The
#              NUMBER is the answer — a `0` here means guard 2 degrades to checks-green, and it is
#              reached only on a CONFIRMED-empty lookup, so it can never be an unread one.
#   SOURCED:   no in-script consumer today; the edge stays open for one.
# No EXIT trap — under bash 3.2 a cleanup trap's last command becomes the script's status,
# laundering a `set -u` abort into exit 0 (#4476, class #4479).

if [ "${BASH_SOURCE[0]}" = "$0" ]; then set -uo pipefail; fi   # executed mode only (ADR 0232)
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

REPO="${REPO:-${1:?step3_5-producer-preflight.sh: REPO unset and no \$1 — refusing to probe an unnamed repo}}"

# Does THIS repo produce run-evidence at all? (a workflow named "run-evidence" defined on the
# default branch). Absent → foreign repo → guard 2 N/A, gated on Step 3. Present → strict path.
# FAIL SAFE: degrade ONLY on a confirmed-empty result. A successful query returns a SINGLE
# count ("0", "1", …); an empty capture means the query itself FAILED (network / auth / rate-
# limit), which must NOT silently skip guard 2 — least of all in the home repo, where the
# strict path is invariant. So an unconfirmed lookup falls through to the strict path
# (HAS_PRODUCER=1), not to degradation: a transient API blip costs strictness, never a skipped
# bundle assertion. NOTE: no `--paginate` — with it, gh feeds each page to `--jq` separately so
# `| length` prints one integer PER PAGE (a multi-line "0\n0" that defeats both the `-z` guard
# and the `-eq 0` test). per_page=100 fits any realistic repo's workflow set in one page.
HAS_PRODUCER=$(gh api "repos/$REPO/actions/workflows?per_page=100" \
  --jq '[.workflows[] | select(.name=="run-evidence")] | length' 2>/dev/null)
# `if … fi`: with a successful lookup the `[ -z … ]` test is FALSE, and an `&& HAS_PRODUCER=1` would
# make that failing test the last command before the branch below — rule 4 of
# `.patterns/skill-script-shell-shape.md` § The dual-mode shape. The substitution is unchanged.
if [ -z "$HAS_PRODUCER" ]; then HAS_PRODUCER=1; fi   # lookup failed (empty) → can't confirm absence → strict
if [ "$HAS_PRODUCER" -eq 0 ]; then
  echo "guard 2 N/A (no run-evidence producer in this repo) — gated on checks (Step 3)"
  # Degraded: guard 2 clears here. Skip the bundle fetch + the four assertions below and
  # proceed to Step 4 on the strength of Step 2 (PASS) + Step 3 (gating checks green).
fi

if [ "${BASH_SOURCE[0]}" = "$0" ]; then printf 'HAS_PRODUCER=%s\n' "$HAS_PRODUCER"; fi
