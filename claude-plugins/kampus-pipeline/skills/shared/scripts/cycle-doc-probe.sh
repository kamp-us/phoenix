#!/usr/bin/env bash
# The product-development-cycle consult hook, extracted from `gh-issue-intake-formats.md` (epic #4435
# phase 1, #4450). The *why* — the graceful-absence contract that keeps the plugin portable (ADR
# 0062): absence is a first-class correct state, never a defect to repair — stays in that contract's
# "cycle-doc consult hook" prose.
#
# MECHANICAL MOVE. Every moved line is byte-identical to the fence it came from and sits at column 0.
# Verbification is phase 2 (#1929, ADR 0228). Do not "improve" it here.
#
# DUAL-MODE (ADR 0232) — `.patterns/skill-script-shell-shape.md` § The dual-mode shape carries the
# why for the whole family; only this file's two contracts are restated here.
#   EXECUTED:  bash ./claude-plugins/kampus-pipeline/skills/shared/scripts/cycle-doc-probe.sh <REPO>
#              stdout ⇒ exactly one line, `CYCLE_DOC=present` or `CYCLE_DOC=absent`.
#   SOURCED:   the sanctioned in-script edge — `plan-epic/scripts/cycle-doc-probe.sh` sources this
#              file for the $CYCLE_DOC it leaves in that script's shell. Unchanged.
# No EXIT trap (#4476, class #4479).
#
# A skill operating on a LOCAL WORKING TREE rather than the API may substitute the equivalent
# `test -f product-development-cycle.md` at the repo root; both must treat absent ⇒ no-op.

if [ "${BASH_SOURCE[0]}" = "$0" ]; then set -uo pipefail; fi   # executed mode only (ADR 0232)

REPO="${REPO:-${1:?cycle-doc-probe.sh: REPO unset and no \$1 — refusing to probe an unnamed repo}}"

# probe the well-known cycle doc; absent ⇒ the cycle-step no-ops (graceful absence, ADR 0062)
if gh api "repos/$REPO/contents/product-development-cycle.md" --jq '.path' >/dev/null 2>&1; then
  CYCLE_DOC=present   # consult it for the containment policy
else
  CYCLE_DOC=absent    # no-op: no marker, no dark-ship, no release queue
fi

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  printf 'CYCLE_DOC=%s\n' "$CYCLE_DOC"
fi
