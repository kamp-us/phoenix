#!/usr/bin/env bash
# §DEV Tier-M — the canonical deviation-disclosure scan, extracted from
# `gh-issue-intake-formats.md` (epic #4435 phase 1, #4450). The *why* — that this scan ARMS the check
# and never decides it, that a hit is a line to judge against the disclosure rather than a FAIL, and
# why the class-6 walk re-decides its flag at every file header — stays in that contract's §DEV prose.
#
# MECHANICAL MOVE. Every moved line is byte-identical to the fence it came from and sits at column 0.
# Verbification is phase 2 (#1929, ADR 0228). Do not "improve" it here.
#
# DUAL-MODE (ADR 0232) — the why is `.patterns/skill-script-shell-shape.md` § The dual-mode shape.
#   EXECUTED:  bash ./claude-plugins/kampus-pipeline/skills/shared/scripts/dev-tier-m.sh <REPO> <PR>
#              stdout ⇒ the two scope lines the body already echoes (§ZS #1 — emit the scanned scope
#              so a drift that silently stops matching shows in the run log instead of reading
#              green), then one `DEV_SUPPRESS_LINE=<text>` per class-5 hit and one
#              `DEV_TESTCUT_LINE=<text>` per class-6 hit — the contents of the two variables the
#              sourced form left in the caller's shell. This scan ARMS the check and never decides
#              it: a hit is a line to judge against the disclosure, not a FAIL.
#   SOURCED:   no in-script consumer today; $DEV_SUPPRESS / $DEV_TESTCUTS stay available for one.
# No EXIT trap (#4476, class #4479).

if [ "${BASH_SOURCE[0]}" = "$0" ]; then set -uo pipefail; fi   # executed mode only (ADR 0232)

REPO="${REPO:-${1:?dev-tier-m.sh: REPO unset and no \$1 — refusing to scan an unnamed repo}}"
PR="${PR:-${2:?dev-tier-m.sh: PR unset and no \$2 — refusing to scan an unnamed PR}}"

# §DEV Tier M — presence of the section, plus the two diff-detectable classes.
# The section-presence pattern below is the canonical copy; `write-code` Step 5 check (e) and
# `review-trivial` Step 0 restate it mechanically, so a change here has to land in all three (the
# rule is single-sourced, the pattern is not — a silent drift un-gates one lane).
BODY="$(gh api repos/$REPO/pulls/$PR --jq '.body')"
printf '%s' "$BODY" | grep -Eiq '^[[:space:]]*#{2,3}[[:space:]]*Deviations[[:space:]]*$' \
  && echo "deviation-disclosure: ## Deviations section present" \
  || echo "deviation-disclosure: ## Deviations section ABSENT — malformed body if the PR OWES the section (absent is not None.); [N/A] if it does not (see 'Who owes the section')"
# class 5, added suppressions/skips
DEV_SUPPRESS="$(gh pr diff "$PR" | grep -E '^\+' \
  | grep -nE 'biome-ignore|eslint-disable|@ts-(expect-error|ignore)|\.(skip|only)\(|xit\(|xdescribe\(' || true)"
# class 6, removed assertion lines — scoped to TEST files, matching the prose. Walk the diff
# file-by-file so a `--- a/src/assert.ts` header can never match as a removed assertion, and only
# removals inside a test file count. A bare `grep '^-'` over the whole diff matched exactly that
# header (the `-` of `---` plus the word `assert` in the path).
# EVERY file header re-decides the flag, and a DELETED file (`+++ /dev/null`) takes its path from the
# `--- a/<path>` side. Keying only on `+++ b/` left the flag STALE across a deletion, which broke the
# scan in both directions: a deleted non-test file after a test file scored false positives, and a
# deleted test file after a non-test file silently dropped its removed assertions — the exact class-6
# case this scan exists to arm.
DEV_TESTCUTS="$(gh pr diff "$PR" | awk '
  /^--- / { p = $0; next }
  /^\+\+\+ / { t = ((($0 ~ /^\+\+\+ b\//) ? $0 : p) ~ /(\.|\/)(test|spec)\.[a-z]+$|\/(__tests__|test|tests)\//) ; next }
  t && /^-[^-]/ && /expect\(|assert|toBe|toEqual|toThrow/ { print }')"
echo "deviation-disclosure: Tier-M scan — $(printf '%s' "$DEV_SUPPRESS" | grep -c .) suppression/skip line(s), $(printf '%s' "$DEV_TESTCUTS" | grep -c .) removed-assertion line(s)"

# A CLEAN scan — zero suppression and zero removed-assertion hits — is this scan's ORDINARY answer,
# and it must arrive at exit 0: §SHARED tells its reader to read the exit status first and treat any
# non-zero as UNKNOWN, so a clean scan returning 1 makes every green PR unreadable. Hence the
# `if … fi` bodies: with both variables empty the `[ -n "" ]` of an `&&` body would be each loop's
# last command, and the second loop's status is the script's
# (`.patterns/skill-script-shell-shape.md` § The dual-mode shape rule 4).
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  printf '%s\n' "$DEV_SUPPRESS" | while IFS= read -r _l; do
    if [ -n "$_l" ]; then printf 'DEV_SUPPRESS_LINE=%s\n' "$_l"; fi
  done
  printf '%s\n' "$DEV_TESTCUTS" | while IFS= read -r _l; do
    if [ -n "$_l" ]; then printf 'DEV_TESTCUT_LINE=%s\n' "$_l"; fi
  done
fi
