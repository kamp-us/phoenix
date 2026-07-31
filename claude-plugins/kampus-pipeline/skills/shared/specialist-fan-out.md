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
is — cite it, don't restate the definitions; the script below is *how* the append step obeys
them. The other three gates run **this same procedure** (one logic, four call sites). It appends by
**reconstructing the issue body** — read it, gate, append the one new row, write it back — never
by a blind edit.

Fence 2 gates whether you may reach this step at all: only an in-scope finding — one that
traces to the issue's stated goal (Route, don't grade above) — arrives here. A finding that
failed the trace test was already routed to `report`; if one reaches you anyway, route it to
`report` and stop. The other three fences are enforced *inside* one executed script, which all
four gates run:

```bash
bash ./claude-plugins/kampus-pipeline/skills/shared/scripts/reviewer-append-ac.sh \
  <ISSUE> <PR> <ROUND_K> <review-code|review-doc|review-skill|review-plan> \
  "<criterion — observable, checkable from the outside>" \
  "<finding — the in-scope defect; what an AC would have required>"
```

- **`ISSUE` / `PR`** — the issue whose `### Acceptance criteria` list the row lands on, and the
  PR the provenance tag records. `review-plan` has no PR, so it passes the **child** issue for
  both (its own §2 tag reads `pr:#<child>`).
- **`ROUND_K`** — the §5/Bounding round-cluster index for this PR; 1-based, a first review is
  round 1. It arrives as an argument because the round count is the gate's to resolve, not the
  append's.
- **`GATE`** — your own namespace, so the row carries §2's per-gate provenance tag
  (`ac:review-code` / `ac:review-doc` / `ac:review-skill` / `ac:review-plan`).

Read the result off **stdout** (ADR
[0232](https://github.com/kamp-us/phoenix/blob/main/.decisions/0232-agents-execute-skill-scripts-never-source-them.md)):
one `APPEND-STATE:` token names which of three outcomes happened, all of them exit 0 — the gate
is never blocked by this step and still posts its normal verdict.

| `APPEND-STATE:` | fence | what happened |
|---|---|---|
| `skipped-below-write-floor` | 3 | your ACL is below `write+`, or the lookup failed — nothing was written; route the finding to `report` |
| `escalated-frozen-round-K` | 4 | the round is at/after K = N = 3 — the escalation comment and `status:needs-triage` landed, the AC did **not** |
| `appended` | 1 | the one new row was written back |

A non-zero exit is the fence-1 abort (a pre-existing line would have changed) or an input the
script could not resolve: nothing on stdout, a named diagnostic on stderr. Treat it as a hold —
the issue body was **not** written. **Known standing condition:** an issue body read back through
`gh api … --jq .body` never ends in a newline, which `diff` reports as its last line *changing*,
so fence 1 aborts on every non-empty body. That over-strictness is inherited verbatim from the
procedure this script was extracted from and is out of scope to relax here — it errs toward
refusing a write, never toward losing a criterion ([#4600](https://github.com/kamp-us/phoenix/issues/4600)).

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

