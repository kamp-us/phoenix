#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091,SC2034,SC2086
# Surface the release queue for the humans after a dark (flag-contained) merge.
#
# Extracted VERBATIM from ship-it/SKILL.md's Step 5b fenced block (epic #4435 phase 1, #4448).
# A byte-move, not a rewrite: replacing this glue with `pipeline-cli` verbs is phase 2 (#1929).
#
# DUAL-MODE (ADR 0232) — the why is `.patterns/skill-script-shell-shape.md` § The dual-mode shape.
#   EXECUTED:  bash ./claude-plugins/kampus-pipeline/skills/ship-it/scripts/step5b-release-queue.sh \
#                   <REPO> <PR> [<ISSUE>]
#              stdout ⇒ one line, `RELEASE_QUEUE=queued (awaiting human flip)` or
#              `RELEASE_QUEUE=n/a (not a dark ship)` — the ledger value the sourced form left in the
#              caller's shell. <ISSUE> is the linked issue Step 1 resolved; an ABSENT one keeps the
#              fenced block's own behaviour — no linked issue means nothing to queue, so the step
#              no-ops and reports `n/a`.
#   SOURCED:   no in-script consumer today; the edge stays open for one.
#
# `pipefail` (executed mode) changes what a PIPELINE's status is, and two detector captures below
# read one, so each is re-derived as capture-then-match. See their comments — the predicates
# themselves are byte-unchanged (ADR 0228/0229).
# No EXIT trap — under bash 3.2 a cleanup trap's last command becomes the script's status,
# laundering a `set -u` abort into exit 0 (#4476, class #4479).

if [ "${BASH_SOURCE[0]}" = "$0" ]; then set -uo pipefail; fi   # executed mode only (ADR 0232)
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

REPO="${REPO:-${1:?step5b-release-queue.sh: REPO unset and no \$1 — refusing to queue a release in an unnamed repo}}"
PR="${PR:-${2:?step5b-release-queue.sh: PR unset and no \$2 — refusing to read the dark-ship signals off an unnamed PR}}"
ISSUE="${ISSUE-${3-}}"   # legitimately empty: no linked issue ⇒ nothing to queue ⇒ the `n/a` no-op

RELEASE_QUEUE="n/a (not a dark ship)"   # default: the no-op state

# Only a REAL dark ship has anything to queue: a linked issue + the cycle doc present (graceful
# absence, ADR 0062), THEN a ground-truth signal that THIS PR shipped a flag-gated feature — never
# the linked issue's (often epic-inherited) Containment stamp, the phantom-release bug #1257 closes.
if [ -n "$ISSUE" ] && gh api "repos/$REPO/contents/product-development-cycle.md" --jq '.path' >/dev/null 2>&1; then
  # (a) the DIFF introduces a flag: an ADDED declaration in the flag-IaC surface
  #     (apps/web/worker/features/flagship/resources.ts — the canonical flag home, ADR 0081).
  #     `+` patch lines are additions; an added `FlagshipFlag(` factory call or a `defaultVariation:`
  #     flag-config line is a real default-off flag THIS PR introduced (write-code Step 4b mints it,
  #     review-code Step 3b verifies it).
  #     CAPTURE-THEN-MATCH: the detector's decision is the GREPS' verdict, and only theirs. Left as
  #     one pipeline under executed mode's `pipefail`, a non-zero `gh` would fold into the status and
  #     answer `no` — a transport failure posing as "this PR ships no flag", which silently skips the
  #     release queue. Capturing the read first restores the original operand exactly; the two greps
  #     and their patterns are untouched.
  FLAG_PATCHES=$(gh api --paginate "repos/$REPO/pulls/$PR/files?per_page=100" \
    --jq '.[] | select(.filename | test("features/flagship/resources\\.ts$")) | .patch // ""')
  FLAG_IN_DIFF=$(printf '%s\n' "$FLAG_PATCHES" \
    | grep -E '^\+' | grep -Eq 'FlagshipFlag\(|defaultVariation:' && echo yes || echo no)

  # (b) the PR BODY declares the dark-ship flag key explicitly (a `Flag:`/`Flag key:` line naming a
  #     kebab-case key) — covers gating behind a flag a PRIOR PR already declared (not in THIS diff).
  #     The leading-prefix allowance absorbs only COSMETIC markdown — leading whitespace, an optional
  #     ATX header (`#{1,6}`, so `## Flag:` / `### Flag key:` match, #1293), and `**` bold — while the
  #     key grammar `[a-z0-9]+(-[a-z0-9]+)+` is untouched, so prose containing "flag" and a non-kebab
  #     key still miss.
  #     Same capture-then-match as (a), same reason: the grep's verdict is the detector, `gh`'s
  #     status is not part of it.
  BODY_RAW=$(gh api repos/$REPO/pulls/$PR --jq '.body // ""')
  FLAG_IN_BODY=$(printf '%s\n' "$BODY_RAW" \
    | grep -Eiq '^[[:space:]]*(#{1,6}[[:space:]]*)?\**[[:space:]]*flag([[:space:]]*key)?:[[:space:]]*\**[[:space:]]*[a-z0-9]+(-[a-z0-9]+)+' && echo yes || echo no)

  # (c) the PR BODY names an ALREADY-DECLARED flag key in a GATING-DECLARATION line (the reused-flag
  #     dark ship, #2086): the flag pre-dates this diff (so (a) misses) and write-code phrased it in
  #     prose — "ships dark behind `phoenix-bildirim`" — rather than the canonical `Flag:` line (so (b)
  #     misses). Two grounds, BOTH required (registry-grounding alone was necessary-but-not-sufficient
  #     — it let a docs/example mention of a real key mis-fire, the #2897/#2843 phantom awaiting-release):
  #     (1) the key is a REAL declared default-off flag — read the `key: <CONST>` list from the flag-IaC
  #     surface (resources.ts) on `main`, resolved to literals via apps/web/src/flags/keys.ts; AND (2) it
  #     appears in GATING context, not documentation/example prose (the FLAG_IN_PROSE scoping below).
  # the const list round-trips through a file only because the two greps are separate streams;
  # it lands under a per-run mktemp, never a shared /tmp leaf (§SP of gh-issue-intake-formats.md).
  # `$$` alone is NOT the guarantee — an agent's Bash calls can share a shell, so two ship-it runs
  # can carry the same PID-derived name, and a clobbered list reads back cleanly as another run's
  # flag keys, silently mis-deciding the dark-ship branch (#3718). This is §SP's rule-4 carve-out:
  # allocated and consumed inside THIS one Bash call, so the kernel's uniqueness is the whole
  # guarantee and no deterministic path is needed (it never has to survive into a later call).
  CONSTS_FILE="$(mktemp "${TMPDIR:-/tmp}/ship-it-flag-consts.XXXXXX")" || {
    echo "ship-it: §SP could not allocate a per-run temp — refusing to read flag consts through a shared path (#3718)." >&2; exit 1; }
  DECLARED_KEYS=$(
    gh api "repos/$REPO/contents/apps/web/worker/features/flagship/resources.ts?ref=main" \
        --jq '.content' 2>/dev/null | base64 -d 2>/dev/null \
      | grep -oE 'key:[[:space:]]*[A-Z0-9_]+' | grep -oE '[A-Z0-9_]+$' | sort -u > "$CONSTS_FILE" || true
    gh api "repos/$REPO/contents/apps/web/src/flags/keys.ts?ref=main" \
        --jq '.content' 2>/dev/null | base64 -d 2>/dev/null \
      | grep -oE '^export const [A-Z0-9_]+[[:space:]]*=[[:space:]]*"[a-z0-9]+(-[a-z0-9]+)+"' \
      | sed -E 's/^export const ([A-Z0-9_]+)[[:space:]]*=[[:space:]]*"([a-z0-9-]+)"/\1 \2/' \
      | while read -r CONST LIT; do grep -qx "$CONST" "$CONSTS_FILE" 2>/dev/null && echo "$LIT"; done
    rm -f "$CONSTS_FILE"
  )
  FLAG_IN_PROSE=no
  if [ -n "$DECLARED_KEYS" ]; then
    BODY_PROSE=$(gh api repos/$REPO/pulls/$PR --jq '.body // ""')
    # Narrow (c) to a GATING/DECLARATION context — the fix for the #2897/#2843 phantom-release
    # false positive. A declared key mentioned only as documentation/example prose ("counts errors
    # captured while phoenix-bildirim was on") reads identically to a real dark-ship declaration
    # under a whole-body grep, so (c) mis-fired and queued a phantom status:awaiting-release. Two
    # scopers restore the distinction WITHOUT dropping (c)'s genuine reused-flag coverage (#2086):
    #   (i) drop fenced ```code``` blocks — an example dark-ship line shown INSIDE a fence is
    #       documentation ABOUT dark-shipping (e.g. a PR editing a pipeline skill), not THIS PR's own
    #       gating declaration.
    #  (ii) keep only GATING-CONTEXT lines — a line carrying `behind` PLUS a dark-ship/gating word,
    #       the exact prose write-code emits for a reused-flag dark ship it phrased instead of the
    #       canonical `Flag:` line ("ships dark behind `phoenix-bildirim`", the #2086 case (a)/(b)
    #       both miss). NOTE the inline `key` backticks are NOT stripped — the whole-token match below
    #       treats a backtick as a boundary char, so `ships dark behind \`phoenix-bildirim\`` still
    #       fires; a naive strip-inline-code fix would false-NEGATIVE this genuine case.
    #  The false positive has no such line (its mention carries no gating intent) ⇒ (c) no-ops.
    GATING_PROSE=$(printf '%s' "$BODY_PROSE" \
      | awk '/^[[:space:]]*```/{f=!f; next} !f' \
      | grep -Ei '(^|[^a-z])behind([^a-z]|$)' \
      | grep -Ei '(^|[^a-z])(dark|ship|ships|shipped|shipping|gate|gated|gates|gating|guard|guarded|hide|hides|hidden|flag)([^a-z]|$)' || true)
    while IFS= read -r K; do
      [ -z "$K" ] && continue
      # whole-token match: the declared key bounded by non-[a-z0-9-] on each side, so a longer key
      # containing this one as a substring (e.g. phoenix-bildirim-x) is NOT matched by phoenix-bildirim
      if printf '%s' "$GATING_PROSE" | grep -Eq "(^|[^a-z0-9-])$K([^a-z0-9-]|\$)"; then FLAG_IN_PROSE=yes; break; fi
    done <<EOF
$DECLARED_KEYS
EOF
  fi

  if [ "$FLAG_IN_DIFF" = yes ] || [ "$FLAG_IN_BODY" = yes ] || [ "$FLAG_IN_PROSE" = yes ]; then
    # deployed-dark (a real flag shipped) → add the linked issue to the release queue for a human flip (#602)
    gh api -X POST "repos/$REPO/issues/$ISSUE/labels" -f "labels[]=status:awaiting-release"
    RELEASE_QUEUE="queued (awaiting human flip)"
  fi
  # no signal ⇒ the PR shipped ungated (the inherited-stamp false positive #1257 closes) ⇒ no-op, no label
fi

if [ "${BASH_SOURCE[0]}" = "$0" ]; then printf 'RELEASE_QUEUE=%s\n' "$RELEASE_QUEUE"; fi
