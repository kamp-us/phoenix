#!/usr/bin/env bash
# The product-development-cycle consult hook, extracted from `gh-issue-intake-formats.md` (epic #4435
# phase 1, #4450). The *why* — the graceful-absence contract that keeps the plugin portable (ADR
# 0062): absence is a first-class correct state, never a defect to repair — stays in that contract's
# "cycle-doc consult hook" prose.
#
# MECHANICAL MOVE. Every moved line is byte-identical to the fence it came from and sits at column 0.
# Verbification is phase 2 (#1929, ADR 0228). Do not "improve" it here.
#
# SOURCE it (`. cycle-doc-probe.sh`) with REPO set: the point is the $CYCLE_DOC it leaves in the
# caller's shell. Sets no shell options and installs no EXIT trap (#4476, class #4479).
#
# A skill operating on a LOCAL WORKING TREE rather than the API may substitute the equivalent
# `test -f product-development-cycle.md` at the repo root; both must treat absent ⇒ no-op.

REPO="${REPO:-${1:?cycle-doc-probe.sh: REPO unset and no \$1 — refusing to probe an unnamed repo}}"

# probe the well-known cycle doc; absent ⇒ the cycle-step no-ops (graceful absence, ADR 0062)
if gh api "repos/$REPO/contents/product-development-cycle.md" --jq '.path' >/dev/null 2>&1; then
  CYCLE_DOC=present   # consult it for the containment policy
else
  CYCLE_DOC=absent    # no-op: no marker, no dark-ship, no release queue
fi
