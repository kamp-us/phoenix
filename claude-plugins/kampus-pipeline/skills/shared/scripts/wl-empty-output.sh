#!/usr/bin/env bash
# §WL — the empty-output form, extracted from `gh-issue-intake-formats.md` (epic #4435 phase 1,
# #4450). The *why* — that a wait-loop's exit is never evidence of the awaited condition, and that
# `grep -qv` / `grep -vq` fails as a condition on BOTH semantics (a `-v` test is true almost
# unconditionally over a multi-line read) and portability (ugrep returns non-zero even when
# non-matching lines exist) — stays in that contract's §WL prose (#4155, #3130 → #3403).
#
# MECHANICAL MOVE. The two moved lines are byte-identical to the fence they came from. One declared
# seam: the fence's illustrative `then …` — the caller's own action — becomes `then return 0`, so the
# predicate is a runnable, shellcheck-able function instead of a syntactically incomplete fragment.
# Verbification is phase 2 (#1929, ADR 0228). Do not "improve" it here.
#
# DUAL-MODE (ADR 0232) — the why is `.patterns/skill-script-shell-shape.md` § The dual-mode shape.
#   EXECUTED:  <path-list> | bash ./claude-plugins/kampus-pipeline/skills/shared/scripts/wl-empty-output.sh
#              The changed-path list arrives on STDIN, because an executed child cannot see the
#              caller's unexported $FILES. stdout ⇒ one line, `WL_ALL_ONCLASS=yes` or
#              `WL_ALL_ONCLASS=no`; the exit status matches (0 / 1), so a caller may read either.
#   SOURCED:   the sanctioned in-script edge — `review-code/scripts/classify-skills-only.sh` sources
#              this file for `kp_wl_all_onclass`, which reads that script's own $FILES. Unchanged.
# No EXIT trap — under bash 3.2 a cleanup trap's last command becomes the script's status, and this
# predicate's whole contract is its exit status (#4476, class #4479).

if [ "${BASH_SOURCE[0]}" = "$0" ]; then set -uo pipefail; fi   # executed mode only (ADR 0232)

# "every changed path is under skills/ or agents/" — the empty-output form. Reads $FILES; returns 0
# only when the set is NON-EMPTY and the inverted match captured NOTHING. Emptiness of the captured
# output is the condition — never the exit status of a `grep -v`.
kp_wl_all_onclass() {
# "every changed path is under skills/ or agents/" — the empty-output form
OFFCLASS=$(grep -vE '^claude-plugins/kampus-pipeline/(skills|agents)/' <<<"$FILES")
if [ -n "$FILES" ] && [ -z "$OFFCLASS" ]; then return 0; fi
return 1
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  FILES="$(cat)"
  if kp_wl_all_onclass; then echo "WL_ALL_ONCLASS=yes"; else echo "WL_ALL_ONCLASS=no"; exit 1; fi
fi
