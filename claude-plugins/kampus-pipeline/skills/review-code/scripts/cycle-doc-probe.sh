#!/usr/bin/env bash
# Step 3b — the one canonical product-development-cycle probe (formats §1). SOURCE it (`. cycle-doc-probe.sh`)
# with REPO set: the point is the $CYCLE_DOC it leaves in the caller's shell. Extracted from
# review-code/SKILL.md (#4451, epic #4435 phase 1). Extraction contract:
# ../SKILL.md § The extracted scripts. The graceful-absence *why* (ADR 0062 — absence is a
# first-class correct state) stays in that step's prose.
#
# A SECOND COPY of ../../shared/scripts/cycle-doc-probe.sh, and no longer a required one. It was
# required: the cycle validators scanned each skill's OWN directory only, so sourcing the shared copy
# moved review-code's cycle wiring off its guarded surface and reddened them. ADR 0230 removed that
# forcing constraint — the validators now follow a skill's own source edges one hop
# (`kp_skill_source_edges` in ../../../lib/common.sh), so sourcing the shared probe stays green.
# Collapsing this copy onto that edge is the intended direction and is deliberately NOT done here:
# minting the new sourced invocation is held behind the open question about `.`-sourcing under
# worktree isolation (#4546). Until then this copy is the drift risk it always was — see #4541.
#
# Sets no shell options and installs no EXIT trap (#4476, class #4479).

REPO="${REPO:-${1:?cycle-doc-probe.sh: REPO unset and no \$1 — refusing to probe an unnamed repo}}"

# the one canonical cycle-doc probe (formats §1); absent ⇒ no cycle ⇒ skip the gating check
# shellcheck disable=SC2034  # $CYCLE_DOC is this script's whole output — it is read by the SOURCING caller
gh api "repos/$REPO/contents/product-development-cycle.md" --jq '.path' >/dev/null 2>&1 \
  && CYCLE_DOC=present || CYCLE_DOC=absent
# run the gating verification below ONLY when:  [ "$CONTAINMENT" = flag ] && [ "$CYCLE_DOC" = present ]
