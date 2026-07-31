## Specialist fan-out + route-don't-grade (ADR 0079) — the shared reference

This is the **reference implementation** of the ADR
[0079](https://github.com/kamp-us/phoenix/blob/main/.decisions/0079-reviewer-authored-acceptance-criteria.md)
mechanism. The AC checklist (Step 3) catches what the issue *named*; it is blind to a real,
in-scope defect the issue's AC never named — a swallowed fault, a missing invariant, an
untested behavioral path that is genuinely part of "make this work" sails through a green gate
because there is no open-ended correctness sweep (by design — focus over a nitpick firehose).
The fan-out closes that blind spot by routing such a finding back into the **single converging
mechanism the loop already drains — the AC checklist** — instead of onto a parallel
severity/advisory track.

**This section is the citable home for the other three gates.** `review-doc`, `review-skill`,
and `review-plan` wire the *same* fan-out + route behavior into their own classes by citing
this section (ADR 0079 §1–§2) — not by re-deriving the dimensions, the route decision, or the
append mechanism. Read it as one logic with four call sites: only the *diff each gate already
loads* and the *class it verifies* differ.

### Fan out over the already-loaded diff (don't re-load it)

Run the specialists **over the diff Step 2 already pulled** (and the review worktree it already
materialized) — the fan-out adds no second checkout, no extra `gh`/worktree cost. The starting
dimensions, per ADR 0079 §1 and **pinned in epic #493's Resolved questions**, are three —
and each is a **checklist line within this single review pass, not a separately spawned agent**
(epic #493's resolved split: a checklist line reuses the loaded context with zero added
orchestration; a dimension *graduates* to a dedicated agent only on evidence it can't hold the
rigor as a line, filed via `report` if/when that happens — the same seam-graduation discipline
as ADR 0040's testing tiers):

- **silent-failure** — a swallowed error, an empty `catch`, a dropped `Effect` failure channel,
  a result whose error path is discarded — a fault the diff makes *unobservable* at runtime.
- **type-design** — a representable invalid state, a widened type that admits what the domain
  forbids, an invariant the types stop enforcing (the "make invalid states unrepresentable"
  bar this repo holds).
- **test-gap** — a behavioral path the diff adds or changes that no test exercises — coverage
  the AC checklist didn't name but "make this work" implies.

Each dimension produces zero or more **findings**: a concrete defect with its diff site. The
fan-out **feeds** findings into the route step below; it does **not** itself emit a verdict.

### Route, don't grade — a finding is a binary in/out-of-scope decision

A finding is **routed, not graded** (ADR 0079 §2). There is **no severity tier and no
confidence score** — the decision is the single binary the `plan-epic` story-trace test already
draws:

- **In-scope** — the finding **traces to the linked issue's stated goal / user story**, the
  **same trace-to-stated-goal test `plan-epic` enforces** for story coverage (ADR
  [0046](https://github.com/kamp-us/phoenix/blob/main/.decisions/0046-plan-epic-prd-grade-plans.md)).
  Route it by **appending a new acceptance criterion** to the linked issue, using the
  **reviewer-append surface defined in
  [`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) §2** — its exact checkbox
  shape, its canonical provenance tag (`<!-- ac:review-code pr:#<PR> round:K -->`), and its four
  fences (append-only · in-scope-only · ACL-gated/fail-closed · frozen-after-round-K).
  **§2 is the single source — cite it; do not restate the tag fields or the fences here**, so
  this reference and the contract cannot drift.
- **Out-of-scope** — the finding is real but does **not** trace to *this* issue's stated goal
  (a tangential defect, an adjacent refactor, a pre-existing bug the diff merely surfaces).
  File it via [`report`](../report/SKILL.md) as a fresh `status:needs-triage` issue; it
  re-enters the pipeline at intake on its own merits. **The current PR is not blocked by it** —
  routing a tangential finding to `report` is exactly what keeps the AC list finite and the
  bounded repair loop converging (§2 fence 2).

### What the append does (and does not) change in *this* review

The fan-out + route is **additive to the existing AC-verification verdict — it does not replace
or weaken it.** The append is the route's *output*, not a new gate:

- The **conjunctive AC verdict (Step 3), the SHA-bound `review-code:` marker (§VERDICT), and the
  single-merge-authority invariant are unchanged.** An appended criterion does **not** change
  *this* PR's pass/fail computation beyond the existing rules: it lands as a new unchecked
  `[ ]` row on the issue, so on the *next* review cycle it is an ordinary criterion the
  conjunctive verdict already covers (an unmet new row is a `[FAIL]` like any other). It enters
  the **next** cycle's work-list; `write-code`'s repair round drains it like any other `[FAIL]`
  row (the existing converging loop), and the next review verifies it.
- **Append the AC before composing the Step 3 / Step 4 verdict**, so the verdict you post
  already reflects the appended row (it shows as a fresh `[FAIL]` in the table, telling
  `write-code` exactly what to drain next round). The append is gated by §2 fence 3 (only a
  `write+` reviewer's append counts, fail-closed — the same ACL author-gate ADR
  [0055](https://github.com/kamp-us/phoenix/blob/main/.decisions/0055-acl-sourced-review-authz.md)
  applies to the verdict marker) and fence 4 (an append in/after round K = N = 3 escalates to a
  human instead of looping — §2's freeze, bound to `write-code`'s existing N=3 repair cap).
- **Out-of-scope findings never touch the AC list or this PR's verdict** — they are `report`
  residue only.

### Performing the append — the four fences, enforced at this site (ADR 0079)

§2 **defines** the four fences; this is where they are **enforced**, so an invalid append is
unrepresentable rather than merely discouraged. §2 stays the single source of *what* each fence
is — cite it, don't restate the definitions; the steps below are *how* the append step obeys
them. The other three gates run **this same procedure** (one logic, four call sites). Append by
**reconstructing the issue body** — read it, gate, append the one new row, write it back — never
by a blind edit:

```bash
# the §2 in-scope-only fence (fence 2) gates whether you may append AT ALL:
# only an in-scope finding (traces to the issue's stated goal — Route, don't grade above)
# reaches here. A finding that fails the trace test was already routed to `report`; it must
# NOT arrive at this append step. If it did, route it to `report` and stop — never append it.

# ── Fence 3: ACL-gated, FAILS CLOSED ──────────────────────────────────────────────────────
# resolve your OWN authority at the GitHub ACL — the same write+ floor ADR 0055 applies to
# verdict-marker authority — BEFORE writing anything. No checked-in allowlist; the repo ACL is
# the trust root. Any non-write+/lookup-failure result fails closed: skip the append, route the
# finding to `report` instead (the PR is not blocked — it still gets your normal verdict).
ME="$(gh api user --jq .login)"
PERM="$(gh api "repos/$REPO/collaborators/$ME/permission" --jq .permission 2>/dev/null)"
case "$PERM" in
  admin|maintain|write) : ;;                       # authorized — proceed
  *) echo "below write+ floor (or ACL lookup failed) — fail closed: do NOT append, route to report"; exit 0 ;;
esac

# ── Fence 4: frozen-after-round-K (K = N = 3) ─────────────────────────────────────────────
# resolve the round K you would tag this append with — the §5/Bounding round-cluster index for
# THIS PR (the same count write-code's cap uses). An append in/after the final repair round has
# no round left to drain-and-re-verify it within the bound, so it ESCALATES to a human instead
# of appending-and-looping (the append-side of write-code's drain-side freeze — §2 fence 4).
ROUND_K=<the §5/Bounding round-cluster index for this PR>   # 1-based; a first review is round 1
if [ "$ROUND_K" -ge 3 ]; then
  # frozen: append-rate must not outrun fix-rate. Escalate, never append — name the finding,
  # hand the PR to a human, surface for re-triage (mirrors write-code's N=3 escalation path).
  gh api repos/$REPO/issues/$ISSUE/comments -f body="$(cat <<EOF
### Append escalation — in-scope finding raised at/after the final repair round (round $ROUND_K)

A reviewer specialist surfaced an in-scope finding, but it arrives in/after \`write-code\`'s
final repair round (K = N = 3), so there is no round left to drain-and-re-verify a fresh AC
within the bound. Per ADR 0079 §2 fence 4 the append is **frozen** — escalating to a human
instead of appending-and-looping:

- <finding> — <the in-scope defect; what an AC would have required>

Needs a human decision (accept as-is, extend the AC's life by a fresh triage, or drop it).
EOF
)"
  gh api -X POST repos/$REPO/issues/$ISSUE/labels -f "labels[]=status:needs-triage"
  exit 0   # frozen → escalated, NOT appended
fi

# ── Fence 1: append-only — add the one new row, never edit/remove a pre-existing one ───────
# read the CURRENT body, append exactly one §2-shaped row (provenance-tagged), write it back.
# Reconstructing the body this way makes removal/edit unrepresentable: every pre-existing line
# is carried through byte-for-byte; only a trailing criterion is added.
BODY="$(gh api repos/$REPO/issues/$ISSUE --jq .body)"
NEW_AC="- [ ] <criterion — observable, checkable from the outside> <!-- ac:review-code pr:#$PR round:$ROUND_K -->"
# append the row under the ### Acceptance criteria list; do not touch any existing row
UPDATED="$(printf '%s\n%s\n' "$BODY" "$NEW_AC")"   # illustrative — insert under the AC heading, preserving every prior line
# fail-closed integrity guard: refuse to write back a body that DROPPED or ALTERED any prior
# line — append-only means every prior line survives verbatim in the new body. If a pre-existing
# line would change, abort (never write a body that lost a criterion — the gate-weakening
# catastrophe fence 1 forbids):
diff <(printf '%s' "$BODY") <(printf '%s' "$UPDATED") | grep -qE '^< ' && { echo "append-only violation: a pre-existing line would change — ABORT, do not write"; exit 1; }
gh api -X PATCH repos/$REPO/issues/$ISSUE -f body="$UPDATED"
```

The append is **append-only by construction** (fence 1): the body is rebuilt from the existing
one with a single row added, and a `diff` guard refuses any write that would drop or mutate a
prior line — so a reviewer flow *cannot* edit or remove an existing AC (the catastrophe
`review-skill`'s gate-invariant check exists to catch). It is **in-scope-only** (fence 2): only
a finding that passed the trace-to-stated-goal test (Route, don't grade) reaches this step; a
tangential one was routed to `report` and never arrives. It is **ACL-gated and fails closed**
(fence 3): a below-`write+` author — or any ACL lookup failure — skips the append entirely, so
an unauthorized identity's "append" never lands on the issue and never counts toward the gate.
And it is **frozen after round K = N = 3** (fence 4): an in-scope finding raised in/after the
final repair round escalates to a human rather than appending-and-looping, so append-rate stays
bounded by fix-rate. None of this changes the verdict computation — the conjunctive AC verdict,
the SHA-bound marker, the ACL author-gate on *verdicts*, the control-plane boundary, and
single-merge-authority are all untouched; the enforcement only makes the *append* safer.

---

