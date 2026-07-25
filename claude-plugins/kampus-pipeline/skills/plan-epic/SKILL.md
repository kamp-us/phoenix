---
name: plan-epic
description: Turn a triaged epic into an executable, PRD-grade task ledger on the configured target repo — a plan whose product layer (problem, user stories, testing strategy) leads and engineering layer follows, split into tracer-bullet sub-issues that each trace to a user story, with a pinned `## Dependencies` topology. Trigger on "plan the epic", "plan epic #N", "break down the epic", "/plan-epic", or whenever a `type:epic` `status:triaged` issue needs its plan and children. Autonomous — no interview or approval gate; re-runs reconcile.
---

# plan-epic

You take a triaged epic (`type:epic` + `status:triaged`) and turn it into something
a fleet of `write-code` agents can execute without you in the loop: a **PRD-grade plan**
written into the epic body, a set of native GitHub sub-issues each carrying its own user-story
trace and acceptance criteria, and a pinned `## Dependencies` section that says what gates what.

"PRD-grade" is the bar this skill exists to hold. A plan that lists only architecture and a
task split is half a plan — it says *how* without ever saying *who needs this and what changes
for them*. Your plan **leads with the product layer** (the problem, the solution from the user's
view, the user stories, the testing strategy) and **then** lays down the engineering layer
(approach, split rationale). The user stories are the spine: they are what you slice the
children from, and every child traces back to one. See ADR
[0046](https://github.com/kamp-us/phoenix/blob/main/.decisions/0046-plan-epic-prd-grade-plans.md) for why.

You operate **autonomously**. The plan you write is read by `write-code` agents, not presented
to a human for sign-off — there is **no interview, no propose-first, no approval gate**. You
author the product layer from the brief + the existing product + codebase exploration + your own
product judgment; you do not ask the user questions (the human already approved the *epic* at
triage). When a user story hinges on a genuine product decision you can't ground from the
codebase, carve it as a `type:decision` child — never handwave it. Plan, split, link, done.

The epic body is **append-down**: the triaged original brief stays untouched at the top — triage
may collapse it into a `<details>` wrap-in-place, but it is preserved byte-for-byte and is still
your input — and you write *below* it. You never rewrite-on-top an epic: its original content is
the brief that grounds your plan, and your surgical splice preserves it verbatim whether or not
it's wrapped. (This is exactly the exception triage carves out for epics; the formats doc spells
out why.)

## All GitHub ops via `gh api` REST — never GraphQL

The kamp-us org runs a legacy Projects-classic integration that breaks GraphQL issue
queries. Every read and write goes through `gh api`. Native sub-issues have a REST
surface (below); use it. This is not a style preference — GraphQL calls error out on
this org.

**Resolve the target repo once, up front.** This skill is repo-agnostic — every `gh api`
call targets `$REPO`, not a hardcoded repo. Resolve it at the top of your run per the shared
contract's **Target repo resolution**
([`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md)): `$CLAUDE_PIPELINE_REPO`
if set, else the current repository. In phoenix this defaults to `kamp-us/phoenix`, so the
behavior is unchanged with no config (ADR 0062 §1).

```bash
REPO="${CLAUDE_PIPELINE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
```

## The formats contract

You **write three of the five** shared formats; read them before you start:
[`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md).

- **`## Dependencies` grammar** (format 1) — the topology you pin at the bottom of
  the epic body: `### Phase N` headings as the sequential spine, the list within a
  phase as a parallel group, `requires: #N` as a cross-boundary gating edge.
  **Topology only** — no retry budgets, no concurrency caps, no code flags; those are
  orchestrator concerns, not shared issue state. (The orchestrator itself is not this repo's
  job — ADR [0046](https://github.com/kamp-us/phoenix/blob/main/.decisions/0046-plan-epic-prd-grade-plans.md); the topology is the
  only dependency artifact phoenix keeps.)
- **Sub-issue body** (format 2) — the shape of every child you create: a **required**
  `**Stories:**` line (the story numbers from your plan this child implements or unblocks), a
  `**TDD:**` flag, an optional `**Containment:**` marker, a `### What to build` prose spec, and a
  `### Acceptance criteria` checklist. Two hard invariants: **every child carries ≥ 1 acceptance
  criterion**, and **every child traces to ≥ 1 user story** (see the coverage invariant in Step 3).
- **The product-development cycle hook** — the cycle-doc consult hook and the per-child
  `**Containment:**` marker, defined once in the formats contract's
  [§The product-development cycle hook](../gh-issue-intake-formats.md#the-product-development-cycle-hook).
  plan-epic is the **only writer** of the marker: when the repo carries a
  `product-development-cycle.md` you stamp each child's containment from the cycle's policy; when
  it's absent the step no-ops (graceful absence, ADR 0062). See Step 3's *Stamp the containment
  marker*.
- **Epic handoff note** (format 4) — you don't *post* these (that's `write-code` as
  children complete), but your plan should make the cross-task signal they'll carry
  predictable. The `## Dependencies` graph is the spine those handoffs route along.

Read the formats doc tolerantly when reconciling an existing plan (re-plan, below) and
write it canonically. Tolerant reading is the safety margin, not the target.

## The glossary — read `.glossary/`, use the canonical terms

As you author the plan — user stories, the `### What to build` spec on each child, the
identifiers you coin — reach for the repo-owned vocabulary register rather than inventing
names (the one-concept-named-four-ways drift the audit found, #851):
[`.glossary/TERMS.md`](https://github.com/kamp-us/phoenix/blob/main/.glossary/TERMS.md)
(domain nouns) and [`.glossary/LANGUAGE.md`](https://github.com/kamp-us/phoenix/blob/main/.glossary/LANGUAGE.md)
(architecture vocabulary). Point at the glossary, never copy a definition into this skill —
the register is the single source. (ADR 0099.)

## Vocabulary impact — surface the domain nouns an epic plan introduces

Reading the glossary (above) keeps you *reusing* existing names; this is its complement — **surfacing the new ones you introduce.** An epic plan is a primary *coining site*: its user stories and `### What to build` specs name the domain nouns a whole fleet of `write-code` agents will then build against, and those names propagate before anyone routes them past a gate. The `review-code` glossary-freshness gate (Step 3c) only catches **structural** surfaces (a new feature folder / package / export); a **concept-level** noun coined in a plan — a new model, a redefined lever, a feature's Turkish brand name — sails past it. So catch it **at coinage, here**, where you already hold the concept (ADR [0128](https://github.com/kamp-us/phoenix/blob/main/.decisions/0128-glossary-concept-trigger-off-the-gate.md) prong (c), Fixes #1737; the parallel is the `/adr` skill's vocabulary-impact section — the two coining skills catch the routed-term class at its source).

This is a **required, not-silently-skippable** part of the plan. As you write Step 2, ask: *does this plan introduce domain nouns not already in `.glossary/TERMS.md`, or redefine an existing one?* You must land on **exactly one** of two explicit outcomes and record it in the plan's `### Vocabulary impact` subsection (Step 2) — you cannot leave it blank:

- **Noun(s) introduced/redefined → feed the glossary.** Name each new domain noun the plan coins (a feature's brand name, a new entity/model, a redefined term), and route it to `.glossary/TERMS.md`: add/update its row when the canonical definition is short and clear, or **invoke `/glossary`** (`claude-plugins/kampus-pipeline/skills/glossary/SKILL.md`) / file a `report` for the fuller treatment. Surfacing it in the plan is what makes the child `write-code` agents inherit the canonical name instead of re-coining a synonym (the one-concept-named-four-ways drift, #851).
- **No vocabulary impact → record it explicitly.** If the plan introduces no new domain noun (it sequences and splits work over already-named concepts), state `### Vocabulary impact` → "none" plainly. The explicit "none" is the recorded outcome — it separates *"checked, there is none"* from *"forgot to check."*

This hook is **off the fail-closed gate by construction**: it is authoring-time judgment in this skill, it blocks no PR and no child, and it does not (and must not) alter `review-code`'s Step 3c. It is the routed-term half of ADR 0128 (alongside `/adr`); the un-routed code-PR class is the sibling drift-sweep backstop, not this skill's job.

## Acquire the epic-lock before you mutate — release it on every exit

`plan-epic` and `review-plan` both mutate one epic's children (you supersede/unlink/close on
re-plan; the gate flips `planned → triaged`). Run concurrently they interleave and corrupt
the ledger (#264). **Before you create, amend, supersede, unlink, or close any child — and
before the body `PATCH` in Step 5 — acquire the `status:planning` epic-lock; release it when
you finish (PASS-or-park), on every exit path including failure.** This is the primary
serialization (ADR [0059](https://github.com/kamp-us/phoenix/blob/main/.decisions/0059-epic-plan-lock.md)); the Step 5
splice+recheck (#261) is the complementary backstop for its residual, not a replacement.

**Acquire (fails closed, two layers).** The lock is **coarse label + agent-distinguishable
claim**, per ADR [0115](https://github.com/kamp-us/phoenix/blob/main/.decisions/0115-agent-distinguishable-claim-marker.md)
(#1452) and the `### The status:planning epic-lock` contract in
[`gh-issue-intake-formats.md`](https://github.com/kamp-us/phoenix/blob/main/claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md):
the `status:planning` label alone is the coarse "is this epic being planned at all?" gate, but
under the single shared `usirin` login two runs that both read it absent both `POST` the same
shared label and neither can tell it won the post-`/labels` TOCTOU (the #1359 double-plan, stray
child #1403). So after `POST`ing the label you post the §7 claim-comment primitive on the epic and
resolve to **exactly one holder by the earliest authorized claim** (ADR 0115 §2). Every step
**fails closed**: a held label, a missing label (the 422 when `status:planning` hasn't been
created in the repo — a canonical lock label, see ADR
[0059](https://github.com/kamp-us/phoenix/blob/main/.decisions/0059-epic-plan-lock.md) §Setup and
the formats doc's status-label table), a missing `CLAUDE_CODE_SESSION_ID`, a failed claim post, or
a lost resolution must **not** fall through to mutate — each backs off and exits 0, so a missing
label, a flaky write, or a co-acquire loss never lets you mutate unlocked. **The back-off `exit 0`
is deliberate** (a held lock, a setup gap, or a lost race is not a plan-epic *failure*) — but it
means a caller keying on exit status alone cannot tell "planned" from "backed off, did nothing";
the echo is the signal, so a wrapper must read it (or re-run) rather than treat `exit 0` as "the
epic was planned".

The whole protocol — the missing-session fail-closed, the coarse-label Rule-0 defer, the
label `POST` (fail-closed on a 422 missing label), the claim-comment `POST`, the checkpoint-GET,
and the earliest-authorized-claim resolution — lives in one deterministic, unit-tested tool,
`pipeline-cli epic-lock` (ADR 0059/0115, #2098), so this skill **calls** it rather than
re-implementing ~50 lines of `jq` inline. Resolve the tool in-repo first, published fallback
(ADR 0064), then branch on its exit status:

```bash
# The `bin/pipeline-cli` shim resolves the CLI (in-repo bin, else the installed bin, else the
# pinned `pnpm dlx` fallback reading hooks/pin.sh) — no version pinned here (#3653; ADR 0064).
LOCK="${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/bin/pipeline-cli epic-lock"

# Acquire the two-layer lock. `epic-lock acquire` runs the WHOLE ADR-0115 protocol over $CLAUDE_CODE_SESSION_ID
# and exits 0 ONLY when the lock is ours; every fail-closed back-off — a held label, a 422 missing label, a
# failed claim post, a lost co-acquire, a missing session id — prints its reason on stderr and exits NON-ZERO.
# Branch on exit status — never mutate on a non-zero.
if ! $LOCK acquire <EPIC>; then
  exit 0   # backed off (held lock / setup gap / lost race is not a plan-epic failure) — re-run later.
fi
# WON. WE hold the lock (label + earliest claim). Release it on EVERY terminal path (below).
```

**Release is an explicit agent step, not a shell `trap … EXIT`.** The acquire above runs in
*one* bash invocation; your subsequent mutations (re-plan supersede/unlink/close, the Step 3
child creates, the Step 5 body `PATCH`) run in *separate later* bash invocations — each its own
process. A `trap … EXIT` armed in the acquire shell fires the instant *that* shell exits, i.e.
**before any mutation runs**, releasing the lock immediately and giving you zero serialization.
So the release can't live in the acquire snippet; it is an action **you** take, deliberately, on
the way out — run this exact `DELETE` once you reach **any** terminal state (PASS/done, parked,
or a failure/abort mid-mutation):

```bash
# release: run on EVERY exit path AFTER a WON acquire (done, park, or fault mid-mutation).
# `epic-lock release` does BOTH parts: (a) retract OUR OWN claim comment(s) — re-found by session id,
# since the acquire ran in a PRIOR process and its comment id is gone here; and (b) drop the coarse
# label — a 404 is benign (already released), but ANY other DELETE failure is surfaced LOUDLY (a
# silently-swallowed DELETE LEAKS the lock and wedges the epic, the exact ADR-0059 catastrophe).
$LOCK release <EPIC>
```

The release fires on **every** terminal path on purpose: you drive this as an LLM agent across
many bash calls, and an agent that aborts (or whose `gh` call throws) part-way through the
mutation must still issue the `DELETE` before it stops — a release that fires only on the clean
fall-through LEAKS the lock on the error/abort path (wedging the epic against every later
plan-epic/review-plan run until a human clears it — the exact catastrophe #264 warns about).
**Only release a lock YOU won** (the step-5 win branch above), never the held label you backed
off from and never a co-acquire loser's shared label (the loser retracts only its **own** claim
comment, in the acquire's step 5 — it never `DELETE`s the label, which the winner still holds; a
loser that deleted it would unlock the winner and reopen the double-plan). A leaked lock is silent
and only a human clears it.

The acquire is **not** a mutex: neither `POST .../labels` (additive, no `If-Match`) nor the
comment API offers a conditional write, so two runs can still both read the label absent and both
`POST` it (the §7/#260 TOCTOU, over the whole child set). What closes the post-`/labels` window is
the agent-distinguishable claim of ADR
[0115](https://github.com/kamp-us/phoenix/blob/main/.decisions/0115-agent-distinguishable-claim-marker.md)
(#1452): of any set of co-acquirers, the **earliest authorized claim** resolves exactly one
planner; every loser self-retracts its claim and backs off (the #1359 double-plan that produced
stray child #1403 is no longer reachable). This stays **detect-and-serialize**: it resolves the
co-acquirers deterministically, it does not provide kernel-grade exclusion, and the residual
same-instant window is still backstopped by Step 5's splice+recheck. Don't claim a guarantee the
API can't give — claim "of any set of co-acquirers, exactly one plans; every loser backs off."

---

## Step 1 — Read the epic and gather context

Read the epic body — the **brief** is the top section, the part above any plan you may
have written on a prior run. Then read enough of the codebase to plan against what's
actually there: the files and modules the brief names, the ADRs in `.decisions/`, the
patterns in `.patterns/`, related issues and PRs. A plan written without the codebase
is a wish list; a plan written from it is executable.

Resolve the brief's open questions **yourself** from the codebase and project
conventions — that is the planning work. The epic brief often ends with open
questions (triage leaves them for you). Answer them in the plan with a stated
rationale; don't punt them downstream as unscoped ambiguity. If a question is
genuinely a product or architecture fork that needs human-judgment — not something the
codebase settles — carve it as its own `type:decision` child rather than blocking the
whole plan on it. (This is the autonomous substitute for the interview a human-facing PRD
tool would run: you resolve what you can and turn the rest into decision work, you don't
stop to ask.)

> In the bash below, `<EPIC>` / `<CHILD>` angle-bracket tokens are placeholders you
> hand-substitute with concrete issue numbers; `$VARS` (e.g. `$CHILD_ID`, `$BODY`)
> are live shell variables the commands set and read.

Every intermediate file below lives under `$RUN_SCRATCH`, the per-run scratch namespace defined
once in [`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) §SP — never a fixed or
epic-keyed `/tmp` path. An epic number is **not** unique (a re-plan of the same epic is a second
run over it), so re-rooting the whole family under one per-run directory is what makes a
cross-run clobber unrepresentable rather than merely unlikely (#3718).

Step 1 writes this state and **Step 5 reads it back from a different Bash call**, so the path
must be *deterministic*, not randomly allocated: shell state doesn't survive between calls, and
a re-run of `mktemp -d` would hand Step 5 a new empty directory instead of Step 1's files. §SP
keys the namespace on `$CLAUDE_CODE_SESSION_ID` exactly so any later call can recompute it —
**open** the run once here (the `rm -rf` clears a previous run of this same epic in this same
session), then **re-derive** it with the same one-liner in every later block, per §SP rule 3:

```bash
# §SP: the per-run scratch namespace — deterministic + fail-closed, never a shared fallback.
[ -n "${CLAUDE_CODE_SESSION_ID:-}" ] || {
  echo "plan-epic: §SP — CLAUDE_CODE_SESSION_ID unset; refusing to write plan state to a shared path (#3718)." >&2; exit 1; }
RUN_SCRATCH="${TMPDIR:-/tmp}/kampus-run/$CLAUDE_CODE_SESSION_ID/plan-epic-<EPIC>"
rm -rf "$RUN_SCRATCH" && mkdir -p "$RUN_SCRATCH" || {
  echo "plan-epic: §SP could not create a per-run scratch dir — refusing to write plan state to a shared path (#3718)." >&2; exit 1; }
```

```bash
RUN_SCRATCH="${TMPDIR:-/tmp}/kampus-run/${CLAUDE_CODE_SESSION_ID:?§SP: session id unset (#3718)}/plan-epic-<EPIC>"   # §SP re-derive (see the open step above)
# the epic, its current body, its labels, and any children it already has
gh api repos/$REPO/issues/<EPIC> --jq '{number,title,labels:[.labels[].name],sub_issues_summary}'
# capture the body AND its revision marker from ONE GET — reading them in two calls lets a writer
# land between them, yielding an updated_at newer than the captured body (TOCTOU skew); the Step 5
# recheck would then either spuriously retry or trust a marker that doesn't match the captured body.
gh api repos/$REPO/issues/<EPIC> --jq '{body,updated_at}' > "$RUN_SCRATCH/snap.json"
jq -r '.body'       "$RUN_SCRATCH/snap.json" > "$RUN_SCRATCH/current.md"
jq -r '.updated_at' "$RUN_SCRATCH/snap.json" > "$RUN_SCRATCH/updated-at.txt"
gh api 'repos/$REPO/issues/<EPIC>/sub_issues?per_page=100' \
  --jq '.[] | "#\(.number) [\(.state)] \(.title)"'
```

If the epic already has sub-issues or a plan section, you're **re-planning** — jump to
[Re-plan](#re-plan-reconciling-a-changed-epic) after you've drafted the new plan, and
reconcile rather than blindly recreate.

---

## Step 2 — Write the PRD-grade plan

Below the untouched brief, write the plan a `write-code` fleet needs, as a
`## Plan (plan-epic)` section whose subsections lead with the **product layer** and then the
**engineering layer**. Write these exact `###` headings, in this order, under
`## Plan (plan-epic)`:

```markdown
## Plan (plan-epic)

### Summary
### Problem & who has it
### What changes
### User stories
### Goal / non-goals
### Resolved questions
### Approach
### Testing strategy
### Task-split rationale
### Vocabulary impact
```

(The `## Dependencies` topology is a separate top-level section you pin in Step 5 — not part
of this plan block.) What each section holds:

**Product layer — lead with this.**

- **Summary** — a plain-language, human-first lead: **2–3 sentences a reader grasps on a
  skim** — what this epic delivers and why it matters, in prose, no jargon — before the
  structured plan below. It **precedes, never replaces**, the product/engineering layers
  that follow (the human-first-summary mandate from
  [#3374](https://github.com/kamp-us/phoenix/issues/3374)).
- **Problem & who has it** — the problem from the user's perspective: who is affected
  (include automated agents — kamp.us is a human-*and*-agent surface), and why it matters
  now. Grounded in the brief + the existing product, not invented. This is the section
  whose absence makes a plan read as "just architecture."
- **What changes** — the solution from the user's perspective: what is different once this
  ships, stated as the experience, not the implementation.
- **User stories** — the spine of the plan, written under the stable `### User stories`
  heading so every child's `**Stories:**` line can reference them by number. Be **extensive** —
  cover the happy path, edge cases, error states, and admin/moderation flows; thin generic
  stories produce thin tasks. Each story should be specific enough to demo. Actors include
  agents where the surface is agent-facing. **These stories are what you slice the children from
  in Step 3, and every child traces back to one** — so write them first and write them well.
  A story that depends on an unresolved product decision becomes a `type:decision` child (Step
  1); don't bury the fork inside a vague story.

  **The story spine MUST be an ordered (`1.`) list — the story's number *is* its id, and the
  `review-plan` epic-ledger floor parses it positionally.** Emit each story as a numbered
  ordered-list item (`1.`, `2.`, `3.`, …), each *As a `<actor>`, I want `<capability>`, so that
  `<benefit>`.* — **never** an unordered bullet (`- …` / `* …`) and **never** a letter-labeled
  bullet (`- **S1 — …`). The floor's `parseEpicStories` collects story ids **only** from
  ordered-list items (`ORDERED_ITEM = /^\s*(\d+)[.)]\s+\S/` in
  `packages/pipeline-cli/src/tools/epic-ledger/markdown.ts`); an unordered or `S<n>`-labeled
  bullet matches **zero**, so the whole epic parses as **zero stories** → a `MISSING_STORIES_SECTION`
  floor FAIL. Worked spine:

  ```markdown
  ### User stories

  1. As a yazar, I want to draft a başlık, so that I can publish it when it's ready.
  2. As a moderator, I want reported entries in a review queue, so that I can act on them.
  3. As an agent, I want a stable fate view for the queue, so that I can drive it headless.
  ```

  The child `**Stories:**` line then references these by their **bare number** — `1`, `2`, `3` —
  never `S1`/`S2` and never wrapped in parenthetical prose that carries digits (see the child
  template in Step 3).

**Engineering layer — then this.**

- **Goal / non-goals** — what this epic delivers, and the tempting-adjacent things it
  deliberately doesn't (the brief's out-of-scope, sharpened).
- **Resolved questions** — each open question from the brief, answered, with the one-line
  rationale grounded in the codebase. This is where the planning judgment shows. Genuine
  human-judgment forks are carved as `type:decision` children instead of answered here.
- **Approach** — the shape of the solution: the modules/layers involved, the data flow, the
  conventions it must honor (cite the ADR/pattern docs). Enough that the child issues don't
  each re-derive the architecture. **No specific file paths or code snippets** — name modules
  and layers, not `path/to/file.ts:42`; paths and snippets go stale fast and the children read
  the live code anyway.
- **Testing strategy** — which behaviors/modules get tested and why, and at which tier (cite
  ADR [0040](https://github.com/kamp-us/phoenix/blob/main/.decisions/0040-testing-taxonomy-and-seam-graduation.md)'s T0–T3
  taxonomy and `.patterns/effect-testing.md`); what makes a good test here (behavior, not
  implementation); prior art in the repo to follow. This is what sets each child's `**TDD:**`
  flag honestly, instead of guessing per child.
- **Task-split rationale** — *why* the work splits the way it does into the children below.
  The split is tracer-bullet vertical (Step 3) and falls on natural seams; the rationale is
  what makes the `## Dependencies` topology legible, and it names which stories each slice
  carries.
- **Vocabulary impact** — the required point-of-coining glossary catch (see [§Vocabulary
  impact](#vocabulary-impact--surface-the-domain-nouns-an-epic-plan-introduces)). Record
  **exactly one** explicit outcome: either the new domain noun(s) this plan coins, each
  surfaced to `.glossary/TERMS.md` (added directly, or routed via `/glossary` / a `report`),
  **or** a plainly-stated "none" when the plan introduces no new term. This section is never
  left blank — the explicit "none" is a recorded outcome, not a skip — and it is a
  coining-time authoring hook only, off the fail-closed `review-code` gate (ADR 0128 prong (c)).

Keep it grounded. No invented requirements, no aspirational scope the brief didn't ask for.
The plan serves the children; if a paragraph doesn't change how a child gets built or what it
delivers to a user, cut it.

---

## Step 3 — Split into sub-issues (tracer-bullet, story-covered)

Slice the plan into executable children. Each implementation child is a **tracer-bullet
vertical slice**: a thin path through *every layer it touches* (storage → service → fate →
UI → tests) that delivers one narrow-but-complete piece of user-visible value, demoable on
its own. Prefer **many thin slices over few thick ones**. A child a `write-code` agent can
pick up cold and finish in a PR or two, with an unambiguous "done".

`type:decision` and `type:investigation` children are the exception to "vertical slice" —
they produce a *record* (an ADR via `/adr`, or a diagnosis), not a layered code change. They
still trace to the stories or forks they unblock.

### The story-coverage invariant (enforced)

This is the discipline that makes the split PRD-derived rather than invented:

- **Every user story is covered by ≥ 1 child.** A story with no child implementing it is an
  unfinished plan — add the child or fold the story.
- **Every child traces to ≥ 1 story** via its `**Stories:**` line — the stories it implements,
  or (for decision/investigation/infra children) the stories it *unblocks*. A child that traces
  to no story is scope creep — cut it. The rare genuinely-pure-infra child that unblocks no
  single story carries the explicit marker `**Stories:** none (pure infra — see What to build)`
  and justifies itself in `### What to build`; the line is never silently left blank.

Before you finish, run the coverage check both directions: list each story → the child(ren)
covering it, and each child → its story(ies). An uncovered story or an untraceable child means
the split isn't done.

Each child's body follows the **sub-issue body format** (format 2) exactly:

```markdown
**Stories:** <REQUIRED — BARE story numbers this child implements or unblocks (`1` or `1, 3` — comma/space-separated, no `S` prefix, no parenthetical prose); or `none (pure infra — see What to build)`>
**TDD:** yes | no
**Containment:** flag (default-off) | exempt (<reason>) | none (no cycle doc)   ← stamped per the cycle-doc hook below; omit (or `none`) when there's no cycle doc

### What to build
<One or two paragraphs of concrete scope: what changes, where, why. Name the
modules/files. State what's out of scope if there's a tempting adjacent thing.>

### Acceptance criteria
- [ ] <observable, externally checkable criterion>
- [ ] <…>
```

(A child's `### What to build` *may* name concrete files — it sits close to the code. Only the
epic-level **Approach** (Step 2) stays path-free, because it ages faster and the children read
the live code anyway.)

The invariants you must hold:

- **≥ 1 user story per child, as BARE numbers.** The `**Stories:**` line is required and never
  blank — it names the stories the child implements or unblocks (or, for the rare pure-infra
  child, the explicit `none (pure infra — see What to build)` marker). See the coverage
  invariant above. **The refs are bare numeric ids** matching the epic's ordered story list —
  `**Stories:** 1` or `**Stories:** 1, 3`, comma/space-separated, **no `S` prefix**
  (`**Stories:** S3` is wrong) and **no parenthetical prose containing digits** (`**Stories:** 3
  (the queue view)` is wrong — the floor's `parseChildStories` extracts *every* digit run after
  `**Stories:**` via `matchAll(/\d+/g)`, so `queue view` prose bleeds stray ids and the "queue"
  in `3 (the queue…)` can't rescue a wrong number). Write the number and nothing digit-bearing
  after it.
- **≥ 1 acceptance criterion per child.** Non-negotiable — `write-code` can't know
  when to stop and `review-code` can't verify without it. If you can't write one,
  the child isn't specified yet.
- **TDD flag honestly set** from the testing strategy (Step 2). `yes` for a behavior with a
  verifiable contract; `no` for config, docs, scaffolding, or an operational step. It's
  advice to write-code, not a gate.
- **Containment marker stamped from the cycle-doc hook** (see *Stamp the containment marker*
  below). When the repo has a `product-development-cycle.md`, every child carries a
  `**Containment:**` line; when it's absent the step no-ops and children carry `none` (or no
  line). The marker's grammar is defined once in the formats contract — you stamp it, you don't
  re-derive it.
- **Self-contained.** A child must not require reading sibling bodies to be understood —
  cross-task context flows through the epic's handoff notes and the `## Dependencies` graph,
  not by reference between child bodies. (The story numbers point into the epic plan's
  `### User stories`, which is shared context, not a sibling body.)

### Emit idempotently — reconcile against what already exists, never re-mint

Child emission is **not** a blind "create one issue per proposed slice." Before you mint a
single child, read the two sets a re-dispatch must reconcile against, so a retry, a
double-dispatch, or a decomposition that overlaps existing work creates **zero duplicates**.
This is the emission-code half of the skill's "re-runs reconcile" promise: the epic-lock
(§Acquire the epic-lock) only serializes *concurrent* runs, it does **not** stop a *sequential*
re-dispatch from re-minting a set the epic already has — a prior run's children, or open work
another issue already tracks (the #2963/#2964/#2965 set re-minted as #2968/#2969/#2970 ~51s
later; #1968 and #2099 the same verdict-resolver work in two places).

**Read both sets once, before the create loop:**

```bash
RUN_SCRATCH="${TMPDIR:-/tmp}/kampus-run/${CLAUDE_CODE_SESSION_ID:?§SP: session id unset (#3718)}/plan-epic-<EPIC>"   # §SP re-derive (see the open step above)
# 1. Already-emitted OPEN children of THIS epic — the re-dispatch idempotency set. A re-run must
#    SKIP any proposed child that matches one of these (reconcile, don't re-create). The sub-issue
#    list is the source of truth for what the epic already spawned; on a mixed open/closed epic
#    prefer it over sub_issues_summary (which undercounts).
gh api "repos/$REPO/issues/<EPIC>/sub_issues?per_page=100" \
  --jq '.[] | select(.state=="open") | .title' > "$RUN_SCRATCH/existing-children.txt"

# 2. The open backlog — the cross-backlog overlap set. A decomposition can re-mint work that
#    already exists as an open standalone issue or another epic's child, so a proposed child that
#    overlaps an open issue is surfaced/skipped, not minted. (REST issue list, not GraphQL.)
gh api "repos/$REPO/issues?state=open&per_page=100" \
  --jq '.[] | select(.pull_request | not) | "#\(.number)\t\(.title)"' > "$RUN_SCRATCH/open-backlog.txt"
```

**Then classify each proposed child before you create it:**

- **Already an open child of this epic** (its slice matches an entry in set 1) → **reconcile,
  don't re-mint.** Skip the create. If the slice's scope drifted, take the re-plan *Amend* path
  (PATCH the existing child) rather than minting a second one. This is what makes a fresh
  re-dispatch on an already-planned epic idempotent — it mints only the children genuinely missing
  from the epic's current sub-issue set.
- **Overlaps an open backlog issue that is not one of this epic's own children** (set 2) → **do
  not mint a duplicate.** Surface the overlap in the plan's `### Task-split rationale` naming the
  existing `#N`, and either fold the slice into a `requires: #N` edge on that issue or drop it from
  the split. A borderline overlap is *surfaced for the reviewer*, never silently minted.
- **Genuinely new** (in neither set) → mint it (atomic create below).

The match is a **judgment call you make**, not a byte-equality gate — normalize titles
(case/whitespace-folded) and read for the same *unit of work*, the way `report`'s pre-file dedup
query reads for an existing issue before filing. When in doubt on the epic's own child, prefer
reconcile (skip/Amend) over a second create; when in doubt on a backlog issue, reference it in the
rationale and let `review-plan` weigh in.

Create each child via REST. **Compose its format-2 body with
`pipeline-cli intake-compose sub-issue`** — the one tested composer for the intake-formats
prose contract §2 — rather than hand-re-deriving the format here (the #3254 cite-the-verb
rule). Hand it the child's fields as a spec JSON and it emits the body **by value** on
stdout, so multi-line markdown and backticks survive the shell without a `<<EOF` heredoc; it
enforces the format-2 invariants (the ≥ 1-acceptance-criterion hard floor) and owns the
leak-safe handoff — a stdout-only verb has no scratchpad file to `@`-reference, so the
`gh api -f body=@<path>` machine-local-path leak (#2002 / #754 / PR #1567) is unreachable.
Allocate the **spec** file with `mktemp` *inside* `$RUN_SCRATCH` (§SP), not a fixed
`/tmp/plan-epic-child.json`: concurrent `plan-epic` runs on sibling epics share `/tmp`, so a
fixed path lets one run's spec clobber another's before it is composed, filing a child under the
right title but with a **sibling epic's `### What to build` + acceptance criteria** — a
cross-epic body bleed the structural floor can't see (it checks markers, never body fidelity),
caught only by `review-plan`'s non-blocking advisor (#754, the same silent-clobber class as
#3718's `prref.txt`). The loop writes one spec per child, so the `mktemp` template matters here
even within a single run:

```bash
RUN_SCRATCH="${TMPDIR:-/tmp}/kampus-run/${CLAUDE_CODE_SESSION_ID:?§SP: session id unset (#3718)}/plan-epic-<EPIC>"   # §SP re-derive (see the open step above)
mkdir -p "$RUN_SCRATCH" || exit 1
# write this child's spec into a per-run temp file, never a shared fixed path (#754)
CHILD_SPEC_FILE="$(mktemp "$RUN_SCRATCH/child.XXXXXX")"
cat > "$CHILD_SPEC_FILE" <<'EOF'
{
  "stories": "<bare numbers, e.g. `1` or `1, 3` — no `S` prefix; or `none (pure infra — see What to build)`>",
  "tdd": "yes",
  "whatToBuild": "<the prose spec>",
  "acceptanceCriteria": ["<observable, checkable criterion>"]
}
EOF
# The verb composes the format-2 body per the contract and emits it BY VALUE to stdout — no
# hand-re-derived `### What to build` / `### Acceptance criteria`, no `-f body=@file` leak.
BODY="$(pipeline-cli intake-compose sub-issue --spec "$CHILD_SPEC_FILE")"
# ATOMIC create — body AND its type/priority/status:planned labels in ONE REST write. `POST /issues`
# accepts `labels` inline, so an interrupted run can never leave a label-less child: the create
# either lands the issue WITH its labels or creates nothing. (Values chosen per the paragraph below.)
gh api repos/$REPO/issues \
  -f title="<sharp single-unit title>" \
  -f body="$BODY" \
  -f "labels[]=type:feature" -f "labels[]=p2" -f "labels[]=status:planned" \
  --jq '{number,id}'
```

Capture both `number` and `id` from the create — Step 4 links by the `id`, so you won't need
to re-fetch it. **Link the child as a native sub-issue (Step 4) immediately after this create** —
the sooner the epic registers the child, the narrower the window a re-dispatch has to reconcile.

Children get their own type from the work they are (`type:feature`, `type:chore`,
`type:bug`, `type:decision`, `type:investigation`) — **not** inherited from the epic — plus a
priority. Do **not** label children `status:needs-triage`: they were born from a triaged plan,
they don't re-enter triage. But they are **not yet pickable either** — they're born
**`status:planned`**, the pre-gate state. `write-code` keys on `status:triaged`, so a
`status:planned` child stays unpickable until the `review-plan` gate validates the ledger and
flips `planned → status:triaged` (per ADR
[0047](https://github.com/kamp-us/phoenix/blob/main/.decisions/0047-review-plan-gate.md) — that flip *is* the whole enforcement
mechanism: an unverified-but-pickable child is unrepresentable). This is the second half of the
transactional-emission guarantee: because the birth labels go on **at create** (atomic, above) and
the birth state is `status:planned` — not `status:triaged` — a half-finished run leaves **no
pickable orphan**. A child interrupted after its atomic create but before its Step-4 sub-issue
link carries `status:planned` (so `write-code` skips it) and is reconciled by the idempotency guard
on the next run — it is never a label-less, pickable ghost (the #2968/#2969/#2970 failure mode, born
body-first with labels applied after).

The child's `type:*` + `p*` + `status:planned` are therefore applied **inline in the create call
above**, never as a separate follow-up write. The standalone `POST .../labels` endpoint is
**additive** (it appends, it doesn't replace) — reserve it for the re-plan *Amend* path, where you
adjust labels on an **already-existing** child:

```bash
# amend-only — append/adjust labels on an EXISTING child. Fresh children are labeled AT CREATE (above),
# so this never runs on the create path; using it there would reopen the label-less-orphan window.
gh api repos/$REPO/issues/<CHILD>/labels \
  -f "labels[]=type:feature" -f "labels[]=p2" -f "labels[]=status:planned"
```

(Type and priority are your call as planner, the same authority triage has — you're
the one who understands the slice.)

### Inherit the epic's milestone (when it has one)

Milestone is one more attribute applied at child creation, alongside the labels above —
but unlike `type:*`/`p*`/`status:planned` it is **conditional and inherited, not your call
as planner**. A child **inherits the parent epic's milestone when the epic has one**, so a
campaign milestone's burndown is **complete by construction**: if a "Search" epic is in the
"Search" milestone, every child it spawns belongs to "Search" too, and the milestone can
actually reach 100%. The milestone is the **one optional intake dimension** — read its
definition and the REST surface from the formats contract's milestone section
([`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md), *Milestone — the one
optional intake dimension*); this is the inherit-logic that section says lives here and cites it.

Read the epic's milestone once, and **only if it has one** PATCH each created child onto it:

```bash
EPIC_MILESTONE=$(gh api repos/$REPO/issues/<EPIC> --jq '.milestone.number // empty')
if [ -n "$EPIC_MILESTONE" ]; then
  gh api -X PATCH repos/$REPO/issues/<CHILD> -f milestone="$EPIC_MILESTONE"
fi
```

**If the epic has no milestone, children stay unmilestoned** — inheritance *copies* the
epic's state, it never invents one. This skill **never creates** a milestone (creating/curating
the set is a human roadmap act, ADR 0072 §3) and assigns a child only to the epic's existing
milestone — never a guessed or fresh one. An unmilestoned epic yielding unmilestoned children is
correct, not a gap to backfill (freeze-by-absence: deliberate absence is a signal, per the
contract section).

### Stamp the containment marker (when the repo runs a product-development cycle)

The containment marker is the per-child cycle decision — the same kind of attribute you apply
at child creation alongside the labels and milestone above, but one you derive from the repo's
cycle policy rather than from the slice itself. Its grammar (the canonical values, the
tolerant-read rule, who writes vs reads it) is defined **once** in the formats contract's
[§The product-development cycle hook](../gh-issue-intake-formats.md#the-product-development-cycle-hook) —
plan-epic is the **only writer** named there; **read that section for the contract, don't
re-derive it here.** The *why* is ADR
[0083](https://github.com/kamp-us/phoenix/blob/main/.decisions/0083-agents-deploy-humans-release.md)
(agents own deployment / humans own release).

Consult the cycle-doc hook using the contract's **one canonical probe** — a content read of
the well-known repo-root `product-development-cycle.md`. Run it once per plan; absent ⇒ this
whole step no-ops (graceful absence, ADR
[0062](https://github.com/kamp-us/phoenix/blob/main/.decisions/0062-repo-as-config-plugin.md)):

```bash
# the formats-contract canonical probe — absent ⇒ no marker stamped (children carry `none`)
if gh api "repos/$REPO/contents/product-development-cycle.md" --jq '.path' >/dev/null 2>&1; then
  CYCLE_DOC=present
else
  CYCLE_DOC=absent
fi
```

- **Cycle doc present.** For each child, consult the cycle's policy and decide the child's
  containment **as the planner** — the same authority you already exercise for the child's
  `type:*` and `p*`. Phoenix's cycle (per its `product-development-cycle.md`): a **user-facing**
  child ships dark, so it carries `**Containment:** flag (default-off)`; an
  **internal / refactor / infra / docs** child has no user-facing surface to contain, so it
  carries `**Containment:** exempt (<reason>)` with the reason naming which (e.g. `exempt (docs)`,
  `exempt (internal refactor)`). Stamp the line into the child body (the `**Containment:**` field
  in the format-2 template above), alongside `**Stories:**` / `**TDD:**`.
- **Cycle doc absent.** The step no-ops: stamp **`none (no cycle doc)`** (or, equivalently, omit
  the line — a missing line reads as `none` per the contract's tolerant-read rule). No other
  behavior changes; the plan is well-formed exactly as it was before this dimension existed.

The judgment of user-facing-vs-exempt is **yours** — it's the same slice-level understanding
that set the child's type and priority. write-code (ship dark) and review-code (verify the
gating) *read* this marker downstream; they never write it.

### Emit the reachability/journey child for a user-facing epic (release-blocking)

The story-coverage invariant above guarantees every story has ≥ 1 child — but it does **not**
force the slice that makes a dark-shipped feature *reachable* (a consuming UI **and** a journey
e2e) to exist as its own blocking child. That gap is exactly how a feature reaches backend-100%
while its UI is never built: the reachability work gets buried inside a backend slice's
acceptance criteria (then silently dropped), or tacked on as an optional tail after the "real"
work — the reactions and the two mecmua instances all graduated backend-complete with no
consuming UI. So when this plan contains **any** user-facing (dark-ship) child — one you stamped
`**Containment:** flag (default-off)` above — emit the reachability work as a **first-class,
release-blocking child of its own**, never an optional tail.

This is the plan-epic side of the vertical-completeness gate (ADR
[0173](https://github.com/kamp-us/phoenix/blob/main/.decisions/0173-vertical-completeness-gate.md),
#2528). Its runtime enforcer is `pipeline-cli reachability-guard check <flag-key>` (#2529) and the
`/release` refusal (#2531) is its sibling consumer — the emitted child and both enforcers key off
**one** notion of reachability, defined once in ADR 0173; don't invent a second here.

**One reachability child per graduating flag key.** A user-facing epic ships behind a Flagship
flag key (the `flag (default-off)` containment); emit one reachability child per such key. Its
`### What to build` names **both** halves of the ADR-0173 reachability contract concretely, so a
`write-code` agent knows what to build and `reachability-guard` can verify it:

- **A consuming UI** — a component under `apps/web/src/**` that references the flag-key constant
  declared in `apps/web/src/flags/keys.ts` (beyond the definition itself), so the feature is
  actually rendered to a user when the flag is on (ADR 0173 §1a).
- **A registered journey e2e** — a spec under `apps/web/tests/e2e/` whose `test`/`describe` title
  carries the `@journey:<flag-key>` tag, exercising the user's path through the feature (ADR
  0173 §2).

The child follows the normal format-2 shape, preserving every existing invariant: it carries a
`**Stories:**` line as **bare numbers** tracing to the user-facing story(ies) it makes reachable
(this child is what *covers* the "as a user I can see/use X" story — not scope creep), ≥ 1
acceptance criterion phrased against the reachability contract (e.g. *"`pipeline-cli
reachability-guard check <flag-key>` passes — a `.tsx` under `apps/web/src/**` consumes the
flag-key constant AND a `@journey:<flag-key>` e2e under `apps/web/tests/e2e/` is registered"*),
and `**Containment:** flag (default-off)` (it is itself user-facing). A genuinely UI-less flag is
the ADR 0173 §3 exemption (a `@reachability-exempt: <reason>` marker in `keys.ts`), not a missing
child — if the epic's flag is exempt, record that in the plan and emit no reachability child.

---

## Step 4 — Link children as native sub-issues

GitHub has a **native sub-issues** relationship — link each child to the epic so it
shows up in the epic's `sub_issues_summary` and the GitHub UI's sub-issue list. This
is the real parent/child edge, not just a `## Dependencies` mention.

The endpoint takes the child's **database id** (`.id`), *not* its issue number:

```bash
# the child's database id (reuse the .id from the Step 3 create if you captured it)
CHILD_ID=$(gh api repos/$REPO/issues/<CHILD> --jq '.id')
gh api -X POST repos/$REPO/issues/<EPIC>/sub_issues \
  -F sub_issue_id=$CHILD_ID \
  --jq '.sub_issues_summary'
```

`-F` (not `-f`) so the id is sent as a number. Confirm the link landed:

```bash
gh api repos/$REPO/issues/<EPIC> --jq '.sub_issues_summary'
# total should equal the number of children you linked
gh api 'repos/$REPO/issues/<EPIC>/sub_issues?per_page=100' \
  --jq '.[] | "#\(.number) [\(.state)] \(.title)"'
```

The exact-equality check holds on the fresh-plan path, where every linked child is
still open. On the **re-plan path** — once you've closed superseded children — don't
rely on it: `sub_issues_summary.total` is known to **undercount** when children are a
mix of open and closed (a GitHub sub-issues caveat). There, the
`GET .../sub_issues` list above is the source of truth for what's actually linked.

To **unlink** a child (you'll need this in re-plan when a child is superseded), the
endpoint is **singular** `sub_issue` (not `sub_issues`), and the id goes in the JSON
body via `--input` — `-X DELETE … -F` does **not** work here:

```bash
echo "{\"sub_issue_id\": $CHILD_ID}" \
  | gh api -X DELETE repos/$REPO/issues/<EPIC>/sub_issue --input -
```

Unlinking does not close the child; it just removes the parent/child edge. Closing is
a separate state change (the journal-note path in re-plan).

---

## Step 5 — Write the body (brief + plan + `## Dependencies`)

Now assemble and pin the full body: **untouched brief** + **the PRD-grade plan from Step 2**
+ **the `## Dependencies` section** referencing the child numbers you just created.

The dependency grammar (format 1): `### Phase N` headings are the sequential spine (every
issue in a phase closes before the next phase starts); the list within a phase is a parallel
group (no ordering between them); `requires: #N` on a child is a cross-boundary gating edge
for a dependency that doesn't fall on a phase boundary. **Topology only** — no retry budgets,
concurrency caps, or code flags (those are the out-of-repo orchestrator's, per ADR 0046).

Derive the topology from the task-split rationale: independent slices share a phase (parallel);
a slice that needs another's output sits in a later phase, or carries a `requires:` for a
single specific predecessor.

**Place the reachability/journey child (Step 3) as a release-blocking sibling, never an optional
tail.** It is what makes a dark-shipped feature graduate-eligible, so the topology must make
graduation *depend* on it: put it in the phase that gates the feature's completion — a sibling
of, or a phase after, the backend slices it consumes — and carry a `requires: #N` on each backend
slice whose surface it renders, so it sits on the critical path to graduation. A reachability
child that nothing gates on, or that lands in a trailing catch-all phase no other slice depends
on, *is* the "optional tail" this exists to prevent (ADR 0173); the graduation the `/release`
refusal (#2531) blocks and the child this topology pins are the same reachability edge.

```markdown
## Dependencies

### Phase 1
- #<a> — <label>
- #<b> — <label>

### Phase 2
- #<c> — <label> (requires: #<a>)
- #<d> — <label>
```

### The write is a guarded read-modify-write, never a blind overwrite

The epic body is **load-bearing shared state** — its `## Dependencies` topology is what
`write-code` reads to decide what's pickable. A second `plan-epic` run, or a `review-plan`
child-flip, or a re-plan loop, can edit the same body concurrently; a blind whole-body
`PATCH` would silently clobber that edit (the lost-update this step exists to prevent — issue
#261, same last-write-wins family as the issue-claim race
[`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) §7 (issue #260) and the
SHA-bound verdict contract, ADR [0058](https://github.com/kamp-us/phoenix/blob/main/.decisions/0058-sha-bound-verdict-contract.md)
(issue #258)). GitHub's issue `PATCH` honors **no** `If-Match`/`If-Unmodified-Since` — there is no
native compare-and-swap — so the write is made safe by **two layers**, in order:

**Layer 1 — surgical section replacement (collision avoidance).** Don't reassemble the body
from your in-memory plan and overwrite the whole thing. Re-read the epic's **current** body
immediately before the write, replace **only the section you changed** (the `## Dependencies`
block, and — when re-planning — the `## Plan (plan-epic)` block), and leave every other byte of
the live body exactly as you just read it. The deterministic splice itself — the heading-count
guards, the first-time-append vs re-plan-in-place decision, and the byte-preserving section
replacement — is the `pipeline-cli epic-splice apply` verb (#3689, extracted from #261); the
block below calls it rather than hand-composing the transform. A concurrent edit to a *different*
part of the body (the brief, a sibling's handoff note, a label-driven addition) then cannot
collide with your write at all — the verb preserved it verbatim because it never reconstructed it.

**Layer 2 — optimistic recheck (abort+retry on a same-section race).** Two writers editing the
*same* section still race. So immediately before the `PATCH`, re-GET the epic's `updated_at` and
compare it to the marker captured in Step 1. If it **moved**, another writer touched the body
since you read it: **abort, re-read the body from scratch, re-derive your section against the
fresh revision, and retry** — never `PATCH` over a body you didn't just read.

The re-derive is the part that makes this honest, and it is **your action, not the script's**.
The block below is a **skeleton you re-run per attempt, not a one-shot you launch once**: a
`## Dependencies` block names concrete child numbers and phase topology, so when the recheck
fires (a racer added/closed a child between your reads) you must **regenerate
`$RUN_SCRATCH/deps.md` — and on a re-plan `$RUN_SCRATCH/plan.md` — against the
freshly-read body** (re-run Step 2's split + Step 5's section derivation) *before* you re-enter
the loop. The script cannot do this for you inside one bash invocation; it can only **refuse to
proceed** until you have. So the recheck branch stamps the fresh base and **breaks out** (it does
not silently `continue` onto a stale `deps.md`), and a guard at the top of each attempt **aborts
loudly** if `deps.md` was not regenerated since the base it splices onto was read — turning the
"re-derive" from a comment you might skip into a precondition the script enforces.

```bash
# §SP: re-derive the per-run scratch namespace — this is a LATER Bash call, so Step 1's
# $RUN_SCRATCH variable is gone. Same recipe ⇒ same directory ⇒ Step 1's files are still there.
# NO `rm -rf` here (that is the OPEN step's job only): clearing it would delete exactly the
# snapshot this step reads back, which is the whole failure §SP rule 3 exists to prevent.
[ -n "${CLAUDE_CODE_SESSION_ID:-}" ] || {
  echo "plan-epic: §SP — CLAUDE_CODE_SESSION_ID unset; cannot re-derive the Step 1 scratch namespace (#3718)." >&2; exit 1; }
RUN_SCRATCH="${TMPDIR:-/tmp}/kampus-run/$CLAUDE_CODE_SESSION_ID/plan-epic-<EPIC>"
# Fail closed if Step 1's state isn't there: the freshness guard below compares file mtimes, and
# `[ existing -nt missing ]` is TRUE in bash — so a missing base would let a STALE block splice
# through silently. Assert presence first; never let the guard decide on absent files (#3718).
for f in current.md updated-at.txt; do
  [ -s "$RUN_SCRATCH/$f" ] || {
    echo "plan-epic: §SP — $RUN_SCRATCH/$f is missing/empty; Step 1's snapshot did not survive." >&2
    echo "  Re-run Step 1 in THIS session before splicing. Refusing to evaluate the freshness guard against absent state." >&2; exit 1; }
done

# "$RUN_SCRATCH/deps.md" = the new `## Dependencies` block. On a RE-PLAN, also
#   "$RUN_SCRATCH/plan.md" = the new `## Plan (plan-epic)` block (set REPLAN=1).
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
# This block is a SKELETON you re-run per attempt, not a one-shot. When the recheck (step 2) fires
# it stamps the fresh base, BREAKS, and hands back to you to re-derive `deps.md` (+ `plan.md` on a
# re-plan) against `$RUN_SCRATCH/current.md` — then you re-invoke the block. The freshness
# guard (step 2.5) refuses to splice a `deps.md` older than the base it would splice onto, so a
# stale block can never re-clobber a racer's legitimate topology.
# Per attempt: re-read → recheck (verify unchanged) → freshness guard → epic-splice apply (guards + splice) → PATCH
# → re-verify our block landed. `landed=1` only after a pass confirms the round-trip; `patched=1`
# records that a PATCH was actually issued (so the terminal verdict can tell "raced every time,
# never wrote" from "wrote and lost"). The terminal check after the loop turns an
# exhausted-or-aborted run into a hard STOP rather than ambiguous output.
landed=0; patched=0
for attempt in 1 2 3; do
  # 1. re-read the LIVE body + its revision marker from ONE GET (coherent — no TOCTOU skew)
  gh api repos/$REPO/issues/<EPIC> --jq '{body,updated_at}' > "$RUN_SCRATCH/live.json"
  jq -r '.body'       "$RUN_SCRATCH/live.json" > "$RUN_SCRATCH/live.md"
  NOW=$(jq -r '.updated_at' "$RUN_SCRATCH/live.json")
  WAS=$(cat "$RUN_SCRATCH/updated-at.txt")

  # 2. optimistic recheck — if the body moved since we last read it, stamp the fresh base and BREAK.
  #    Re-deriving the section is YOUR action (the script can't regenerate deps.md/plan.md inside one
  #    bash invocation): re-run Step 2's split + Step 5's derivation against the now-fresh
  #    `-current.md`, then re-invoke this block. The freshness guard (2.5) enforces that you did.
  if [ "$NOW" != "$WAS" ]; then
    echo "epic body changed since read ($WAS -> $NOW) — RE-DERIVE deps.md (+ plan.md on a re-plan)"
    echo "  against the fresh base, then re-invoke this block. (Not auto-retried: the re-derive is an agent step.)"
    cp "$RUN_SCRATCH/live.md" "$RUN_SCRATCH/current.md"   # fresh base to re-derive against
    echo "$NOW" > "$RUN_SCRATCH/updated-at.txt"
    break
  fi

  # 2.5. freshness guard — `deps.md` (and, on a re-plan, `plan.md`) MUST have been (re-)derived
  #      against the base this attempt is splicing onto. That base is `-current.md` (stamped from the
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
     || { [ "${REPLAN:-0}" = 1 ] && { [ ! -s "$RUN_SCRATCH/plan.md" ] \
          || ! [ "$RUN_SCRATCH/plan.md" -nt "$RUN_SCRATCH/current.md" ]; }; }; then
    echo "ABORT: deps.md (or plan.md on a re-plan) is NOT newer than the base it splices onto (-current.md) —"
    echo "       you re-invoked without re-deriving. Re-run Step 2's split + Step 5's section derivation"
    echo "       against "$RUN_SCRATCH/current.md", then re-invoke this block. Refusing to splice a stale block."
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
  PLAN_ARG=(); [ "${REPLAN:-0}" = 1 ] && PLAN_ARG=(--plan-file "$RUN_SCRATCH/plan.md")
  if ! node packages/pipeline-cli/src/bin.ts epic-splice apply \
        --body-file "$RUN_SCRATCH/live.md" \
        --deps-file "$RUN_SCRATCH/deps.md" \
        "${PLAN_ARG[@]}" > "$RUN_SCRATCH/body.md"; then
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
  gh api -X PATCH repos/$REPO/issues/<EPIC> -f body="$BODY" >/dev/null; patched=1
  gh api repos/$REPO/issues/<EPIC> --jq '.body' \
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
    echo "       "$RUN_SCRATCH/current.md", then re-invoke this block. Refusing to re-splice the stale block."
    gh api repos/$REPO/issues/<EPIC> > "$RUN_SCRATCH/snap.json"   # one snapshot, no TOCTOU between body+updated_at
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
fi
```

**Keep the brief byte-for-byte.** With the `epic-splice` verb's surgical splice/append this is
automatic: a first-time plan appends the `## Dependencies` block to a verbatim copy of the live
body; a re-plan copies the live body up to the `## Dependencies` heading verbatim and re-appends
the fresh block. Either way the brief above the plan is untouched bytes from the live read; on a
re-plan the `## Plan (plan-epic)` block is itself re-spliced in place, and everything outside the
two changed sections is verbatim — don't reflow the brief, don't "tidy" it, don't reconstruct it
from memory — splice around it.

**Honest residual — this narrows the window, it is not a lock.** The recheck (layer 2) only
*detects* a race that completed before this run's read; a writer who edits **after** your
`updated_at` read but **before** your `PATCH` lands is still lost-update territory, because the
`PATCH` itself is last-write-wins (GitHub offers no conditional write on issue bodies). Layer 1
shrinks the blast radius to *same-section* collisions; layer 2 narrows the same-section window;
the re-confirm in step 6 — diffing the whole `## Dependencies` block that round-tripped, not the
section heading or a single child line two racers might share — catches the loser *after the fact*
so it retries rather than failing silently, and the terminal verdict turns an exhausted-or-aborted
run into a hard STOP rather than a silent half-write. What this is
**not** is mutual exclusion — true single-writer safety on one epic would
need a designated single planner or a CAS the API doesn't provide (same honest framing as the
issue-claim semantics in [`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) §7 and
the SHA-bound verdict contract, ADR 0058). Don't claim a "lock"; claim "no silent lost-update of
the topology," which is what the acceptance asks for.

Sanity-check the result: the brief is still on top, the plan follows (product layer first),
the `### User stories` section is present, the `## Dependencies` numbers match the children that
exist and are linked, and every story maps to a child (the coverage invariant).

---

## Step 6 — Close the graduated source investigation (close-on-graduation)

An epic often **graduates from a resolved investigation**: the investigation's diagnosis is
folded into an epic whose brief declares its provenance (e.g. `Emitted from resolved
investigation #2570`). Once you've planned that epic, its work is carried forward by the epic +
its children — so the **source investigation must be closed** as the durable "graduated into
#EPIC" record, not left open as `status:triaged` looking pickable. Graduation had no
close-on-source forcing function, so graduated investigations lingered open and inflated the
backlog until a manual dedup sweep hand-closed them (#2988). plan-epic is the deterministic step
that always touches a graduated epic, so it closes the source here rather than trusting a human to
remember — the same enforce-at-the-path discipline the wayfinder emission close applies to maps.

Scan the **brief** (the top section you read in Step 1) for the graduation-provenance marker and
close each source it names — but only a genuine `type:investigation` source, idempotently:

```bash
RUN_SCRATCH="${TMPDIR:-/tmp}/kampus-run/${CLAUDE_CODE_SESSION_ID:?§SP: session id unset (#3718)}/plan-epic-<EPIC>"   # §SP re-derive (see the open step above)
[ -s "$RUN_SCRATCH/current.md" ] || { echo "plan-epic: §SP — Step 1's current.md did not survive; re-run Step 1 in THIS session." >&2; exit 1; }
# Extract every source the brief graduated from — tolerant of phrasing ("Emitted from resolved
# investigation #N", "from resolved investigation #N"). The `resolved investigation` anchor is what
# distinguishes a graduation provenance from an incidental `#N` cross-reference in the brief.
SOURCES=$(grep -oiE 'resolved investigation #[0-9]+' "$RUN_SCRATCH/current.md" \
  | grep -oE '[0-9]+' | sort -u)
for SRC in $SOURCES; do
  # Guard, fail-safe: close ONLY an open type:investigation — never a referenced epic/decision/bug,
  # and never re-close a closed source (idempotent, so a re-plan run is a clean no-op). This is what
  # keeps legitimately-open downstream artifacts (the epic itself, sibling epics) untouched.
  read -r STATE TYPES < <(gh api repos/$REPO/issues/$SRC \
    --jq '[.state, ([.labels[].name] | map(select(startswith("type:"))) | join(","))] | @tsv')
  case "$STATE:$TYPES" in
    open:*type:investigation*) ;;
    *) echo "plan-epic: source #$SRC is $STATE ($TYPES) — not an open investigation, skipping close."; continue ;;
  esac
  # Audit trail (AC): the `tracker graduate` verb owns the graduation-close envelope (ADR 0190,
  # #3266) — it posts the source → artifact provenance record so a reader can trace the graduation,
  # then closes the source as completed (the work graduated, it wasn't abandoned — distinct from
  # triage's not_planned). Don't hand-roll the comment + `state_reason=completed` PATCH; that inline
  # re-derivation is what the adoption lint (#3254) flags.
  pipeline-cli tracker graduate "$SRC" \
    --artifact "epic #<EPIC> (planned by plan-epic)" \
    --note "closing this investigation as the durable \`graduated into #<EPIC>\` record. Its diagnosis is carried forward by the epic and its planned children." >/dev/null
  echo "plan-epic: closed graduated source investigation #$SRC → epic #<EPIC>."
done
```

Only the *source* that graduated is closed; the epic and every downstream artifact it links stay
open (AC). If the brief carries no `resolved investigation #N` marker the loop no-ops — a
plain-authored epic has no source to close.

---

## Re-plan: reconciling a changed epic

When you're re-run on an epic that already has a plan and children (the brief changed,
scope shifted, a child was closed), you **rewrite the plan and the task split
together** — but you don't blow away history. Re-derive the user stories first (they may have
grown or shifted), then judge **each existing child individually** against the new story set:

| Verdict | When | Action |
|---|---|---|
| **Keep** | The child is still a faithful slice of the new plan and still covers its story. | Leave it. If only its *framing* drifted, you may amend its body, but its identity stands. |
| **Amend** | The child's intent survives but its scope/criteria/stories moved. | PATCH its body to the new spec (preserve its acceptance-criteria + `**Stories:**` discipline). It stays linked, same number. |
| **Supersede** | The child no longer fits — the plan dropped it, merged it, or replaced it with a differently-shaped unit. | Close it with a **journal note** (below), unlink it, and create the replacement fresh if there is one. |
| **Frozen** | The child is already `closed` (its work merged). | Leave it untouched — it's history; the new plan builds on it. Never reopen or supersede a closed-done child. |

After reconciling, re-run the **story-coverage check** (Step 3) against the new story set:
a newly-added story with no child needs one; an orphaned child needs a story or a cut.

A child **created fresh during a re-plan** — a Supersede replacement, or one filling a newly-added
story — is born exactly like a first-plan child: it inherits the epic's milestone the same way
(Step 3, *Inherit the epic's milestone*), conditional on the epic having one.

**Closed-done children are history — never reopen or supersede them.** A child that's
already `closed` because its work merged is part of the record. The new plan builds on
top of it; it doesn't pretend the work didn't happen. Only **open** children are
candidates for amend/supersede.

### The journal note (superseding a child)

Every supersede is auditable. Before closing a superseded child, post a comment saying
*why* and where the work went, so the trail is legible:

```bash
gh api repos/$REPO/issues/<CHILD>/comments \
  -f body="Superseded by re-plan of #<EPIC>: <specific reason — e.g. 'scope merged into #<NEW>' or 'dropped, the brief no longer asks for X'>."
# unlink from the epic (singular sub_issue, id in the JSON body), then close not-planned
CHILD_ID=$(gh api repos/$REPO/issues/<CHILD> --jq '.id')
echo "{\"sub_issue_id\": $CHILD_ID}" | gh api -X DELETE repos/$REPO/issues/<EPIC>/sub_issue --input -
gh api -X PATCH repos/$REPO/issues/<CHILD> -f state=closed -f state_reason=not_planned
```

### Fall back to full-supersede when reconciliation is messy

Per-child judgment is the default because it preserves the most history. But when the
plan changed so much that mapping old children to new ones is a tangle — you can't
cleanly say which old child maps to which new one — **don't force a bad mapping.**
Full-supersede instead: close every *open* child with a journal note pointing at the
new plan, then create the new split clean. Closed-done children stay as history
untouched. A clean new split with honest journal notes beats a contorted
keep/amend mapping that leaves children half-describing the old plan and half the new.

After reconciling children, rewrite the plan body and the `## Dependencies` section
(Steps 2 and 5) to match the surviving + new children. The brief stays untouched on
top, as always. The re-plan write goes through **the same guarded read-modify-write as
Step 5** — surgical section splice + optimistic `updated_at` recheck, never a blind
whole-body `PATCH`. Re-plan is exactly the concurrency hot-spot the guard exists for: a
re-plan loop racing a fresh `plan-epic` run or a `review-plan` child-flip is the
lost-update case in issue #261. Write the fresh `## Plan (plan-epic)` block to
`$RUN_SCRATCH/plan.md`, the fresh `## Dependencies` block to
`$RUN_SCRATCH/deps.md`, and run the Step 5 loop with `REPLAN=1` so it splices
**both** sections into the freshly-read live body in place (the live body already has exactly one
`## Dependencies` heading and exactly one `## Plan (plan-epic)` heading to splice against — the
loop's anchor guards abort if either drifted). When `updated_at` moved since your read, the loop
breaks and hands back so you **re-derive both blocks against the fresh base** before re-invoking it
— the re-derive is your step, not the script's, and the freshness guard enforces you did it. (On a
first-time plan, leave `REPLAN` unset — the live body has no `## Dependencies` heading yet, so the
loop appends the new block to EOF instead of splicing, and the Plan-heading guard is skipped.)

---

## Cleaning up after a dry-run

When validating against a **scratch epic** (a throwaway you created to test the skill,
not a real backlog epic), tear it down afterwards so the real backlog stays clean.
Closing isn't enough — the children and the epic should be removed. You can't delete
issues via the public REST API, so the honest cleanup is: unlink and close every
scratch child not-planned, close the scratch epic, and label them so they're
unmistakably test debris.

```bash
# for each scratch child: unlink + close
CHILD_ID=$(gh api repos/$REPO/issues/<CHILD> --jq '.id')
echo "{\"sub_issue_id\": $CHILD_ID}" | gh api -X DELETE repos/$REPO/issues/<EPIC>/sub_issue --input -
gh api -X PATCH repos/$REPO/issues/<CHILD> -f state=closed -f state_reason=not_planned
# then close the scratch epic
gh api -X PATCH repos/$REPO/issues/<EPIC> -f state=closed -f state_reason=not_planned
```

(If you have repo-admin and the GraphQL `deleteIssue` mutation is available to you,
deleting outright is cleaner — but GraphQL is unreliable on this org, so closing is
the dependable path.) Never run dry-run validation against a real epic; spin up a
scratch one.

---

## Running it

A single invocation takes one epic from triaged brief to executable ledger: read the epic +
codebase (Step 1), write the PRD-grade plan — product layer (problem / solution / **user
stories** / testing strategy) then engineering layer (Step 2), split into tracer-bullet
children that each trace to a story — emitted idempotently (reconciled against the epic's existing
children and the open backlog so a re-dispatch or overlap mints no duplicate) and transactionally
(labels applied at create so a half-run leaves no pickable orphan) (Step 3), link them as native
sub-issues (Step 4), pin the full body with its `## Dependencies` topology (Step 5), and close the
graduated source investigation when the epic declares one (Step 6). Re-runs reconcile.

Acquire the `status:planning` epic-lock before you mutate (see [§Acquire the
epic-lock](#acquire-the-epic-lock-before-you-mutate--release-it-on-every-exit)) and **release
it when you finish — on success, park, or failure.** A lock left held wedges the epic against
every later `plan-epic`/`review-plan` run until a human clears it.

Report back a short ledger: the epic, the story count, the children created (with the story
each covers), and the phase topology. Don't narrate every REST call — the epic body and the
linked sub-issues are the durable record.

## Conventions

This skill is one of a suite (`report` → `triage` → **`plan-epic`** → `review-plan` →
`write-code` → `review-code` → `ship-it`) that turns GitHub issues into an agent-operable
pipeline. The shared label semantics and the body/comment/dependency/story formats live in
[`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md); the decision to make
plan-epic's output PRD-grade, story-driven, coverage-enforced, and autonomous (with the
personal PRD/orchestrator harness deliberately kept out of the repo) is ADR
[0046](https://github.com/kamp-us/phoenix/blob/main/.decisions/0046-plan-epic-prd-grade-plans.md). Your input is a
`type:epic` + `status:triaged` issue from `triage`; your output — the epic body's PRD-grade
plan + `## Dependencies`, and the linked sub-issues with their story traces and acceptance
criteria — is what `write-code` reads to pick, sequence, and execute the work, once the
`review-plan` gate has flipped each child `status:planned → status:triaged` (ADR
[0047](https://github.com/kamp-us/phoenix/blob/main/.decisions/0047-review-plan-gate.md)).
