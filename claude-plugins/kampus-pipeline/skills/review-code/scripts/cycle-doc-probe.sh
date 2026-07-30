#!/usr/bin/env bash
# Step 3b — the one canonical product-development-cycle probe (formats §1). SOURCE it (`. cycle-doc-probe.sh`)
# with REPO set: the point is the $CYCLE_DOC it leaves in the caller's shell. Extracted from
# review-code/SKILL.md (#4451, epic #4435 phase 1). Extraction contract:
# ../SKILL.md § The extracted scripts. The graceful-absence *why* (ADR 0062 — absence is a
# first-class correct state) stays in that step's prose.
#
# DELIBERATELY NOT the shared ../../shared/scripts/cycle-doc-probe.sh, even though the two are
# equivalent: the cycle validators (../validate-cycle-presence.sh / ../validate-cycle-absence.sh)
# resolve each skill's scan surface via `kp_skill_shell_surfaces`, which is scoped to the skill's OWN
# directory on purpose — so sourcing the shared copy would move review-code's cycle wiring off its
# guarded surface and the validators would fail, correctly. Per-skill wiring stays per-skill; the rule
# is stated once at `kp_skill_shell_surfaces` in ../../shared/lib/common.sh.
#
# Sets no shell options and installs no EXIT trap (#4476, class #4479).

REPO="${REPO:-${1:?cycle-doc-probe.sh: REPO unset and no \$1 — refusing to probe an unnamed repo}}"

# the one canonical cycle-doc probe (formats §1); absent ⇒ no cycle ⇒ skip the gating check
# shellcheck disable=SC2034  # $CYCLE_DOC is this script's whole output — it is read by the SOURCING caller
gh api "repos/$REPO/contents/product-development-cycle.md" --jq '.path' >/dev/null 2>&1 \
  && CYCLE_DOC=present || CYCLE_DOC=absent
# run the gating verification below ONLY when:  [ "$CONTAINMENT" = flag ] && [ "$CYCLE_DOC" = present ]
