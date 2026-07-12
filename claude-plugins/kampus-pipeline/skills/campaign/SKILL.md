---
name: campaign
description: >-
  Record an approved audit wave onto the roadmap as a bounded campaign — the intake ritual that turns a founder-approved, wave-labeled cluster of issues into a milestone-backed campaign draining through the platform lane. Given a wave label, run the ritual end to end: gate first on the founder-approval trace (fail closed via `pipeline-cli campaign verify-trace`), create/attach the campaign milestone and stamp it on the wave's issues, re-price those issues to p1 so they drain concurrent with the active product arc, and open a PR adding the campaign's row to ROADMAP.md's `## Campaigns` section. Symmetric lifecycle — `active` (create) and `done` (complete): completing a campaign flips its ROADMAP row to `done` and closes the milestone, as guarded as starting one. INVOKER-AGNOSTIC — a human OR an agent may run it; the founder-approval trace is the sole authorization (no human-only guard). Trigger on "campaign <wave-label>", "record the <wave> audit wave as a campaign", "start the campaign for <wave>", "complete the <wave> campaign", "campaign done <wave-label>", "/campaign".
---

# campaign

You are recording an **approved audit wave** onto the roadmap as a **bounded campaign** — a
milestone-backed push that drains through the platform lane *concurrent* with the active product
arc (ADR
[0072](https://github.com/kamp-us/phoenix/blob/main/.decisions/0072-milestones-encode-strategic-sequencing.md)
strategic-sequencing semantics; ADR
[0078](https://github.com/kamp-us/phoenix/blob/main/.decisions/0078-product-driven-decisions-by-default.md)
engineering-led). An audit wave enters as bulk `report`-filed issues sharing a **wave label**
(the [`report`](../report/SKILL.md) → [`triage`](../triage/SKILL.md) seams stay untouched;
wave-ness is that shared label). This skill is the small, release-precedent intake mechanism that
promotes such a wave into a campaign the roadmap knows about, in one guarded ritual: **gate →
milestone + assign → p1 re-price → ROADMAP.md Campaigns-row PR.**

The founder ruling this skill discharges: audit-type intake (security/architecture audit waves)
must be *recorded to the roadmap* as bounded campaigns rather than draining invisibly (the
`## Campaigns` section, own milestone, platform-lane concurrency). The design question of *what
mechanism* resolved to this skill.

## INVOKER-AGNOSTIC — a human OR an agent may run it (no human-only guard)

Unlike [`release`](../release/SKILL.md), this skill has **no human-at-keyboard guard 0**. A human
*or* an autonomous agent may run it, because recording a campaign is not a control-plane act like
flipping production serving — it is the roadmap bookkeeping that follows an approval already
granted. What makes that safe is that the **founder-approval trace is the *sole* authorization**:
the only thing that lets a wave become a campaign is a durable, founder-authored approval marker
bound to the wave label (the gate in Step 1). Whoever runs the ritual, the trace is what
authorizes it — so there is no second, invoker-shaped guard to satisfy, and the gate fails closed
for human and agent alike.

The trust anchor is the **founder identity**, injected as config, **never hardcoded** — no named
identity lives in this skill or any artifact it writes. Resolve it once, the same way the verifier
does (`--founder` flag, else `$CAMPAIGN_FOUNDER_LOGIN`):

```bash
FOUNDER="${CAMPAIGN_FOUNDER_LOGIN:?set $CAMPAIGN_FOUNDER_LOGIN (or pass --founder) — the founder identity is the authorization anchor; refuse without it rather than fall back to any implicit login}"
```

Resolve `$REPO` the repo-agnostic way the rest of the pipeline does (ADR
[0062](https://github.com/kamp-us/phoenix/blob/main/.decisions/0062-repo-agnostic-pipeline.md)):

```bash
REPO="${CLAUDE_PIPELINE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
```

All GitHub reads/writes below go through **`gh api` REST** — never GraphQL (the org's
Projects-classic integration errors GraphQL issue/PR queries, the standing pipeline constraint).

## Preconditions — the wave label, the lifecycle direction, the campaign name

You need three inputs before the ritual:

1. **The wave label.** A shared label naming the audit-wave cluster (e.g. `mentor-audit`). Every
   issue carrying it is a member of the wave. Confirm it names a non-empty cluster before you act:

   ```bash
   WAVE_LABEL="<the shared wave label>"
   gh api -X GET "repos/$REPO/issues" -f "labels=$WAVE_LABEL" -f state=all -f per_page=100 --paginate \
     --jq '.[] | select(.pull_request | not) | "#\(.number)\t\(.state)\t\(.title)"'
   ```

2. **The lifecycle direction — `active` (create) or `done` (complete).** Default is `active`
   (record a new campaign). Pass/say `done` to complete an existing campaign. The two paths are
   symmetric and both go through the same gate — see [Symmetric lifecycle](#the-symmetric-lifecycle--active-create-and-done-complete).

3. **The campaign name** — the founder-voice display name for the ROADMAP row (`Campaign` cell).
   For `done`, this is the name of the already-recorded row you're completing.

---

## Step 1 — Gate: verify the founder-approval trace, fail closed

**Before any mutation** — before you create a milestone, stamp a label, re-price an issue, or open
the ROADMAP PR — call the fail-closed **founder-approval-trace verifier** (the sibling child,
issue #2658) against the wave label. It is the sole authorization for both the `active` and `done`
paths, and it **exits 0 only on a present, well-formed, founder-authored, wave-bound trace**;
every other input (absent, malformed, non-founder author, zero scope) exits non-zero (ADR
[0092](https://github.com/kamp-us/phoenix/blob/main/.decisions/0092-gates-fail-closed-on-zero-scope.md)):

```bash
cd packages/pipeline-cli
node src/bin.ts campaign verify-trace "$WAVE_LABEL" --founder "$FOUNDER" \
  || { echo "campaign: REFUSED — no valid founder-approval trace for '$WAVE_LABEL'. The wave stays un-recorded." >&2; exit 1; }
```

The trace the verifier requires is a **founder-authored comment**, on any issue carrying the wave
label, whose first line is `campaign-approve: <wave-label> · <ISO-8601-UTC>` (the grammar is the
verifier's — the README under `packages/pipeline-cli/src/tools/campaign/` is the single source;
this skill *calls* the verifier, it never re-derives the marker). If the trace is absent, that is
the founder never having approved this wave — **stop and report it**, do not proceed to conjure a
campaign. This gate is the skill's load-bearing invariant, not advice: it is what makes the
skill safe to run invoker-agnostically.

If you are running the `done` path, run the **same gate** first — completing a campaign is as
guarded as starting one, so a wave with no approval trace can neither be created nor completed.

---

## Step 2 — Milestone: create or attach the campaign milestone

A campaign is pinned to its **own** GitHub milestone — the operational projection of the ROADMAP
row (ADR 0072). Resolve the milestone with this precedence, and **never guess a product
milestone** (an arc's milestone from `## Arcs`) — a campaign runs concurrent with, not inside, a
product arc:

- **An existing campaign milestone the founder curated** — if the founder already created a
  milestone for this wave, attach to it. List open milestones and match by title/description:

  ```bash
  gh api "repos/$REPO/milestones?state=all&per_page=100" --jq '.[] | "#\(.number)\t\(.state)\t\(.title)"'
  ```

- **Otherwise provision the campaign's own milestone** — the roadmap act the founder approval
  authorizes. Create a dedicated milestone whose title is the campaign name (never reuse an arc
  milestone):

  ```bash
  MILESTONE_NUMBER=$(gh api -X POST "repos/$REPO/milestones" \
    -f "title=<Campaign name> campaign" \
    -f "description=<one-line campaign scope> (bounded, platform-lane drained)." \
    --jq .number)
  ```

Then **stamp the milestone on every wave-labeled issue** so the milestone projection matches the
cluster (the milestone is set per-issue via the issue-edit endpoint):

```bash
for N in $(gh api -X GET "repos/$REPO/issues" -f "labels=$WAVE_LABEL" -f state=all -f per_page=100 --paginate \
    --jq '.[] | select(.pull_request | not) | .number'); do
  gh api -X PATCH "repos/$REPO/issues/$N" -F "milestone=$MILESTONE_NUMBER" >/dev/null
done
```

**Assignments.** Record who owns the campaign's drain if the founder named owners (assign the wave
issues, or leave them to the normal unassigned-pick if the campaign drains through the pipeline).
The pipeline pick is milestone-aware (`work milestone N`), so pinning the milestone is what lets
[`write-code`](../write-code/SKILL.md) drain the campaign as a cohort.

---

## Step 3 — p1 re-price: price the wave to drain via the platform lane

Re-price every wave issue to **`p1`** so the campaign drains concurrent with the active product
arc through the platform lane (ADR 0072/0078: `p1` is current-arc-relative priority, and the
campaign runs alongside whichever arc is active). Swap any existing `p0`/`p2` for `p1` on each
wave issue:

```bash
for N in $(gh api -X GET "repos/$REPO/issues" -f "labels=$WAVE_LABEL" -f state=all -f per_page=100 --paginate \
    --jq '.[] | select((.pull_request | not) and .state=="open") | .number'); do
  for P in p0 p2; do gh api -X DELETE "repos/$REPO/issues/$N/labels/$P" >/dev/null 2>&1; done
  gh api -X POST "repos/$REPO/issues/$N/labels" -f "labels[]=p1" >/dev/null
done
```

Only open issues need re-pricing — a closed wave issue has already drained and its priority is
moot.

---

## Step 4 — ROADMAP.md Campaigns-row PR

The campaign becomes visible on the roadmap by **a PR that edits `ROADMAP.md`'s `## Campaigns`
table** — the parsed contract the `roadmap-guard` CI gate binds to (the ROADMAP format is the
sibling child #2647; this skill targets its pinned grammar, it does not redefine it). The table's
columns are `Campaign | Milestone | State`, the milestone pinned **by number** (`#N`), and
`State ∈ {active, done}`.

Branch off fresh `main`, edit the table, and open the PR (edit under your own checkout/worktree,
never the primary):

- **`active` (create).** **Append** the campaign row in the `active` state, pinned to the Step-2
  milestone number:

  ```
  | <Campaign name> | #<MILESTONE_NUMBER> | active |
  ```

- **`done` (complete).** **Flip** the existing row's `State` cell from `active` to `done` (leave
  the milestone pin) — see the [done path](#the-symmetric-lifecycle--active-create-and-done-complete)
  for the paired milestone close.

Open the PR against the wave's tracking issue so it closes on merge:

```bash
git switch -c "<prefix>/campaign-<wave-label>-<active|done>" origin/main   # branch off fresh main in your worktree
# edit ROADMAP.md's ## Campaigns table, commit ROADMAP.md by explicit path
gh api -X POST "repos/$REPO/pulls" \
  -f "title=roadmap: record <Campaign name> campaign (<active|done>)" \
  -f "head=<branch>" -f "base=main" \
  -f "body=Records the <Campaign name> audit wave (\`$WAVE_LABEL\`) as a bounded campaign — milestone #<MILESTONE_NUMBER>, p1, platform-lane drained. Founder-approval trace verified. Fixes #<tracking-issue>."
```

The PR keeps `roadmap-guard` green **by construction**: creating a campaign adds a row that
**claims** the (open) milestone Step 2 provisioned — satisfying I3 (no unclaimed open milestone) —
and pins it by number (I1). The row-PR is the seam that keeps ROADMAP.md and the milestone
projection in sync; do not stamp the milestone (Step 2) without the paired row, or the guard fails
on an unclaimed open milestone.

This PR goes through the normal review gate like any other — the skill **stops at PR-open**; it
does not self-review or merge.

---

## The symmetric lifecycle — `active` (create) and `done` (complete)

A campaign has a **two-state** lifecycle (there is no `queued` — unlike an arc, a campaign is not
sequenced ahead; it opens `active` when the founder starts it and ends `done`). Both transitions
run the **same gate** (Step 1), so completing a campaign is exactly as guarded as starting one:

- **`active` — create.** Steps 1 → 2 → 3 → 4 as above: gate, provision + stamp the milestone,
  p1-re-price the wave, open the Campaigns-row PR adding the `active` row.

- **`done` — complete.** When the campaign's milestone is fully drained, complete it:
  1. **Gate** (Step 1) — the same founder-approval-trace check.
  2. **Close the milestone** — the operational projection of a finished campaign:

     ```bash
     gh api -X PATCH "repos/$REPO/milestones/$MILESTONE_NUMBER" -f state=closed >/dev/null
     ```
  3. **Flip the ROADMAP row to `done`** in a Campaigns-row PR (Step 4, `done` variant) — the row's
     `State` cell goes `active → done`, keeping the milestone pin.

  Closing the milestone and flipping the row are **paired**: `roadmap-guard`'s I3 only requires
  *open* milestones to be claimed, so a `done` row pinned to a now-closed milestone is in sync. Do
  the two together in the same PR-and-close so the roadmap never shows a `done` row over an open
  milestone (or a closed milestone under an `active` row).

---

## Worked example — the Mentor Audit campaign (`mentor-audit`, milestone #27)

The **Mentor Audit** campaign is the validation case this skill walks end to end: a security &
architecture audit wave (the karma double-bump race, per-actor rate limiting, ops runbooks,
`SECURITY.md`, …) filed as a cluster of `report` issues sharing the `mentor-audit` label.

**Recording it (`active`).** Given `WAVE_LABEL=mentor-audit`:

1. **Gate.** `campaign verify-trace mentor-audit --founder "$FOUNDER"` — passes only if a
   founder-authored `campaign-approve: mentor-audit · <ts>` comment exists on a `mentor-audit`
   issue. No trace ⇒ refuse, the wave stays un-recorded.
2. **Milestone.** Attach to the curated `Mentor Audit campaign` milestone (`#27`) — a dedicated
   campaign milestone, not a product arc's — and stamp `#27` on every `mentor-audit` issue.
3. **p1 re-price.** Every open `mentor-audit` issue → `p1`, so the wave drains via the platform
   lane alongside the active **Four Pillars** arc.
4. **ROADMAP row PR.** Append `| Mentor Audit | #27 | active |` to `## Campaigns`, opened as a PR
   that closes its tracking issue.

**Completing it (`done`).** Once `#27` is fully drained: run the gate again, close milestone `#27`
(`PATCH .../milestones/27 state=closed`), and open the Campaigns-row PR flipping the row to
`| Mentor Audit | #27 | done |`. The closed milestone under a `done` row keeps `roadmap-guard`
in sync.

This is the campaign the ROADMAP.md `## Campaigns` section already carries as its first row — the
skill's job is to make recording the *next* such wave the same one guarded ritual.

---

## The ritual is done — stop at PR-open

The `campaign` ritual ends when the Campaigns-row PR is open (`active`) or open-and-milestone-closed
(`done`). There is **no self-review, no merge** — the ROADMAP PR goes through the normal review
gate like any other change. If any step failed — the gate refused, the milestone couldn't be
resolved, an issue wouldn't re-price — **stop at the failure and surface it**; never open a
"recorded" ROADMAP row over a wave whose approval trace didn't verify. The gate-before-mutation
ordering is what keeps an un-approved wave from ever reaching the roadmap.
