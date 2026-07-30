#!/usr/bin/env bash
# Step 5's guarded read-modify-write of the epic body: re-read → optimistic recheck → freshness
# guard → `epic-splice apply` → PATCH → confirm OUR WHOLE `## Dependencies` block round-tripped.
# The *why* — the two layers, the honest residual, and why the re-derive between attempts is YOUR
# action and not this script's — stays in ../SKILL.md § The write is a guarded read-modify-write.
#
# usage: splice-body.sh <EPIC> [--replan]
#
# This is a SKELETON you re-run per attempt, not a one-shot: when the recheck fires it stamps the
# fresh base, BREAKS, and hands back to you to re-derive deps.md (+ plan.md on a re-plan) against
# $RUN_SCRATCH/current.md before you re-invoke. `--replan` is the moved block's `REPLAN=1`.
#
# Reads  $RUN_SCRATCH/{current.md,updated-at.txt,deps.md} (+ plan.md on a re-plan).
# Writes $RUN_SCRATCH/{live.json,live.md,body.md,deps-expected.md,deps-live.md} and re-stamps
#        current.md/updated-at.txt on a race.
#
# Exit 0 iff the block LANDED (the round-trip confirmed); every other terminal path — an aborted
# guard, an exhausted loop, a racer's clobber — exits non-zero with its verdict on stdout, so
# "could not land" can never be read as "pinned".
#
# Extracted from plan-epic/SKILL.md (#4452, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: splice-body.sh <EPIC> [--replan]" >&2; exit 2; }
EPIC="$1"; shift
REPLAN=0
case "${1:-}" in
  --replan) REPLAN=1 ;;
  "") ;;
  *) echo "usage: splice-body.sh <EPIC> [--replan]" >&2; exit 2 ;;
esac
REPO="$(kp_repo)" || exit 1
PCLI="$(kp_pcli)" || exit 127
# §SP: re-derive the per-run scratch namespace — this is a LATER Bash call, so Step 1's
# $RUN_SCRATCH variable is gone. Same recipe ⇒ same directory ⇒ Step 1's files are still there.
# NO `rm -rf` here (that is the OPEN step's job only): clearing it would delete exactly the
# snapshot this step reads back, which is the whole failure §SP rule 3 exists to prevent.
RUN_SCRATCH="$(kp_scratch_path "plan-epic-$EPIC")" || exit 1
# Fail closed if Step 1's state isn't there: the freshness guard below compares file mtimes, and
# `[ existing -nt missing ]` is TRUE in bash — so a missing base would let a STALE block splice
# through silently. Assert presence first; never let the guard decide on absent files (#3718).
for f in current.md updated-at.txt; do
  [ -s "$RUN_SCRATCH/$f" ] || {
    echo "plan-epic: §SP — $RUN_SCRATCH/$f is missing/empty; Step 1's snapshot did not survive." >&2
    echo "  Re-run Step 1 in THIS session before splicing. Refusing to evaluate the freshness guard against absent state." >&2; exit 1; }
done

# "$RUN_SCRATCH/deps.md" = the new `## Dependencies` block. On a RE-PLAN, also
#   "$RUN_SCRATCH/plan.md" = the new `## Plan (plan-epic)` block (pass --replan).
#   Give each block a trailing blank line so the next spliced heading stays separated.
# Landing is confirmed against the WHOLE `## Dependencies` block round-tripping byte-for-byte,
# NOT a single line: two concurrent runs on the SAME epic likely both emit a given `- #<child>`
# line (they share children), so a lone matching line can't tell our section from a racer's
# clobber (see step 6). deps.md is re-derived by YOU between attempts (the recheck breaks out and
# hands back; step 2) — the freshness guard (step 2.5) enforces it was, so each pass splices a block
# derived against the body it's splicing onto, never a stale one.
# A first-time plan has NO `## Dependencies` heading yet (Step 2 doesn't write one) — that case
# APPENDS the block to EOF; a re-plan has exactly one and SPLICES it in place. Zero headings on a
# re-plan, or more than one ever, is corruption: the `epic-splice` verb (step 3) exits non-zero.
#
# Per attempt: re-read → recheck (verify unchanged) → freshness guard → epic-splice apply (guards + splice) → PATCH
# → re-verify our block landed. `landed=1` only after a pass confirms the round-trip; `patched=1`
# records that a PATCH was actually issued (so the terminal verdict can tell "raced every time,
# never wrote" from "wrote and lost"). The terminal check after the loop turns an
# exhausted-or-aborted run into a hard STOP rather than ambiguous output.
landed=0; patched=0
for attempt in 1 2 3; do
  echo "attempt $attempt"
  # 1. re-read the LIVE body + its revision marker from ONE GET (coherent — no TOCTOU skew)
  gh api "repos/$REPO/issues/$EPIC" --jq '{body,updated_at}' > "$RUN_SCRATCH/live.json" || break
  jq -r '.body'       "$RUN_SCRATCH/live.json" > "$RUN_SCRATCH/live.md"
  NOW=$(jq -r '.updated_at' "$RUN_SCRATCH/live.json")
  WAS=$(cat "$RUN_SCRATCH/updated-at.txt")

  # 2. optimistic recheck — if the body moved since we last read it, stamp the fresh base and BREAK.
  #    Re-deriving the section is YOUR action (the script can't regenerate deps.md/plan.md inside one
  #    bash invocation): re-run Step 2's split + Step 5's derivation against the now-fresh
  #    `current.md`, then re-invoke this script. The freshness guard (2.5) enforces that you did.
  if [ "$NOW" != "$WAS" ]; then
    echo "epic body changed since read ($WAS -> $NOW) — RE-DERIVE deps.md (+ plan.md on a re-plan)"
    echo "  against the fresh base, then re-invoke this script. (Not auto-retried: the re-derive is an agent step.)"
    cp "$RUN_SCRATCH/live.md" "$RUN_SCRATCH/current.md"   # fresh base to re-derive against
    echo "$NOW" > "$RUN_SCRATCH/updated-at.txt"
    break
  fi

  # 2.5. freshness guard — `deps.md` (and, on a re-plan, `plan.md`) MUST have been (re-)derived
  #      against the base this attempt is splicing onto. That base is `current.md` (stamped from the
  #      live body the recheck above just confirmed unchanged), and your re-derive writes deps.md
  #      AFTER it — so deps.md must be newer than current.md (`-nt` = "newer than"). If it isn't, the
  #      re-derive precondition is unmet (you re-invoked without regenerating the block off the fresh
  #      base): a stale block that references the wrong child set. Abort loudly, don't write — this is
  #      what stops the `continue`-era footgun of re-splicing the originally-derived block (issue #261).
  #      `-nt` alone CANNOT carry this check: `[ existing -nt missing ]` is TRUE in bash, so if the
  #      derived block is absent the negation is false and the guard PASSES SILENTLY — a stale/no
  #      block splices through. Assert the file exists and is non-empty FIRST, then compare mtimes.
  if [ ! -s "$RUN_SCRATCH/deps.md" ] \
     || ! [ "$RUN_SCRATCH/deps.md" -nt "$RUN_SCRATCH/current.md" ] \
     || { [ "$REPLAN" = 1 ] && { [ ! -s "$RUN_SCRATCH/plan.md" ] \
          || ! [ "$RUN_SCRATCH/plan.md" -nt "$RUN_SCRATCH/current.md" ]; }; }; then
    echo "ABORT: deps.md (or plan.md on a re-plan) is NOT newer than the base it splices onto (current.md) —"
    echo "       you re-invoked without re-deriving. Re-run Step 2's split + Step 5's section derivation"
    echo "       against \"$RUN_SCRATCH/current.md\", then re-invoke this script. Refusing to splice a stale block."
    break
  fi

  # 3. splice/append the changed section(s) via the shared verb — `pipeline-cli epic-splice apply`
  #    owns the deterministic transform (#3689, extracted from #261): the exact-`## Dependencies`
  #    heading-count guards (0 + first-time → APPEND to EOF; exactly 1 → SPLICE in place; 0 on a
  #    re-plan or >1 ever → corrupt, exit 1) and, on a re-plan, the in-place `## Plan (plan-epic)`
  #    splice with its own exactly-one-heading guard. Everything OUTSIDE the replaced section(s) is
  #    preserved byte-for-byte (the brief especially — layer 1). Pass `--plan-file` ONLY on a
  #    re-plan: its presence IS the re-plan signal (both sections re-spliced); omit it first-time.
  #    A corrupt/duplicated/drifted heading makes the verb exit non-zero — break loudly and inspect
  #    by hand rather than blind-write. The recheck/freshness/round-trip orchestration around it
  #    stays here (it is live-issue IO, not a text transform).
  #    The argv is built as ONE array that is never empty: on bash 3.2 under `set -u`, expanding an
  #    EMPTY array (`"${PLAN_ARG[@]}"` on a first-time plan) aborts the script mid-decision.
  SPLICE_ARGS=(epic-splice apply --body-file "$RUN_SCRATCH/live.md" --deps-file "$RUN_SCRATCH/deps.md")
  [ "$REPLAN" = 1 ] && SPLICE_ARGS+=(--plan-file "$RUN_SCRATCH/plan.md")
  if ! "$PCLI" "${SPLICE_ARGS[@]}" > "$RUN_SCRATCH/body.md"; then
    echo "ABORT: epic-splice refused (corrupt/duplicated/drifted heading — see its stderr) — refusing to splice; inspect by hand"
    break
  fi
  BODY="$(cat "$RUN_SCRATCH/body.md")"

  # 5. extract THIS run's whole `## Dependencies` block (heading → EOF) from the body we're about
  #    to write — that exact multi-line block is what we'll confirm round-tripped, so a racer who
  #    happens to share a child number can't satisfy the check with one matching `- #` line.
  awk '/^## Dependencies[[:space:]]*$/{f=1} f{print}' "$RUN_SCRATCH/body.md" \
    > "$RUN_SCRATCH/deps-expected.md"

  # 6. write, then re-confirm OUR WHOLE BLOCK landed — extract `## Dependencies`→EOF from the live
  #    post-write body and diff it against the block we just wrote. A racer's clobber differs
  #    somewhere in the block (different topology/labels/ordering), so an exact block match — not a
  #    heading or a single child line — is what tells our section from theirs. The residual window
  #    (below) means the PATCH is still last-write-wins; this is the honest after-the-fact check
  #    that retries the loser.
  gh api -X PATCH "repos/$REPO/issues/$EPIC" -f body="$BODY" >/dev/null; patched=1
  gh api "repos/$REPO/issues/$EPIC" --jq '.body' \
    | awk '/^## Dependencies[[:space:]]*$/{f=1} f{print}' > "$RUN_SCRATCH/deps-live.md"
  if diff -q "$RUN_SCRATCH/deps-expected.md" "$RUN_SCRATCH/deps-live.md" >/dev/null; then
    echo "epic body updated, our whole ## Dependencies block round-tripped"; landed=1; break
  else
    # A racer clobbered our write. Do NOT auto-re-splice the stale deps.md — that would
    # silently re-clobber the racer's legitimate same-section topology change. Mirror the
    # recheck-break (step 2): snapshot the racer's body as the FRESH base, then break to hand
    # back to the agent to RE-DERIVE deps.md (and plan.md on a re-plan) against it before any
    # re-splice. The freshness guard (step 2.5) then enforces the re-derive on the next invoke,
    # so a stale block can never re-clobber.
    echo "our ## Dependencies block is NOT the one in the post-write body — a racer clobbered it."
    echo "       Re-derive deps.md (and plan.md on a re-plan) against the refreshed"
    echo "       \"$RUN_SCRATCH/current.md\", then re-invoke this script. Refusing to re-splice the stale block."
    gh api "repos/$REPO/issues/$EPIC" > "$RUN_SCRATCH/snap.json"   # one snapshot, no TOCTOU between body+updated_at
    jq -r '.body'       "$RUN_SCRATCH/snap.json" > "$RUN_SCRATCH/current.md"      # fresh base to re-derive against
    jq -r '.updated_at' "$RUN_SCRATCH/snap.json" > "$RUN_SCRATCH/updated-at.txt"
    break
  fi
done

# Terminal verdict — the loop can exit several ways; only one is success. An orchestrator (and the
# next agent reading the transcript) must not mistake an exhausted-or-aborted run for a win. The two
# non-success modes differ: a run that NEVER issued a PATCH (raced + re-derived, or a guard aborted)
# left the body untouched; a run that DID PATCH but lost the round-trip left it possibly half-written.
if [ "$landed" != 1 ]; then
  echo "plan-epic: could NOT land the ## Dependencies block — STOP and inspect, do not proceed."
  if [ "$patched" = 1 ]; then
    echo "  (A PATCH was issued but our block didn't round-trip — a racer clobbered it. The epic body"
    echo "   may be half-written with someone else's topology; the topology this run derived is NOT pinned.)"
  else
    echo "  (No PATCH was ever issued — either a guard aborted (corrupt/duplicated heading, or deps.md"
    echo "   not re-derived against the fresh base), or every attempt raced and handed back to re-derive."
    echo "   The epic body is untouched; the topology this run derived is NOT pinned.)"
  fi
  # The moved block ended here with the verdict on stdout only; a script's caller reads the exit
  # status too, so the non-success paths must NOT exit 0 — that is exactly "could not land" read as
  # "pinned" (§ZS).
  exit 1
fi
