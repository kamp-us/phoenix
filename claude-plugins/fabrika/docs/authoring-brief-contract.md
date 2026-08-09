# fabrika authoring-brief contract

An **authoring brief** is a GitHub issue: the boot document a fresh `/skill-creator` session works
out of when it authors one fabrika skill. This doc fixes what a brief carries and what the session
owes back.

**Every `/skill-creator` session works out of a GitHub issue, and every skill gets its own fresh
session** — founder workflow ruling, recorded on
[#4650](https://github.com/kamp-us/phoenix/issues/4650#issuecomment-5150192649). The freshness is
deliberate: no context inheritance, no authoring bias carried from the last skill. The cost of a
stateless session is that nothing survives between them, and the issue seam is what pays it — a
brief that is complete is the *only* reason a session with no memory can author correctly.

So the bar every rule below serves is one sentence:

> **A fresh session, given only the brief issue and this repo, can author the skill without asking a
> question and without reading any prior session's transcript.**

## The tool is the founder's existing `/skill-creator`, used as-is

fabrika builds no authoring tool. The session runs the founder's **existing** `/skill-creator`,
unmodified — [#4648 scope correction](https://github.com/kamp-us/phoenix/issues/4648#issuecomment-5152523719).
What fabrika owns is the ground that tool authors *into* and *against*: this brief format, the skill
conventions, and the CLI interface convention (both in this directory — see
[the docs index](README.md)).

And it is the **only** door — founder ruling
[#4637-C](https://github.com/kamp-us/phoenix/issues/4637), restated on the
[fabrika README](../README.md). A skill that reaches `claude-plugins/fabrika/skills/` by any other
route is a defect, not a shortcut. That has a consequence for how a brief sits on the board, which
is [its own section](#a-brief-is-not-write-code-work) below.

## Required fields

Six. A brief missing any of them is not bootable, and the session's correct response to an
incomplete brief is to say so on the issue rather than to fill the gap by guessing.

### 1. Skill — the name and where it lands

The skill's name and its destination directory, `claude-plugins/fabrika/skills/<name>/`. One brief,
one skill, one directory.

### 2. v1 baseline reference — a path, and nothing more

The repo-relative path of the v1 skill this one replaces, under
[`../../kampus-pipeline/skills/`](../../kampus-pipeline/skills/) — for a skill with no v1 ancestor,
an explicit **none**.

**It is reference, never source of truth** ([#4638
ruling](https://github.com/kamp-us/phoenix/issues/4638)). The session reads it to learn what
problems the skill solves and what scars it carries; it does not port it, mirror its structure, or
treat its shell scripts as the contract. v1 is the frozen comparison baseline, not the design. A
brief that says "rebuild this" has specified nothing; the fields below are the specification.

### 3. Incidents — what the rebuild must not regress

The rows from the **ruled KEEP corpus** that bear on this skill, each as a number plus the
one-line behavior it records. The corpus is the fabrika eval feedstock — the pipeline's observed
scar tissue, kept precisely because each row is a real incident encodable as a regression case —
and it is a file you **read**, not a join you re-run:
[`ruled-keeps.json`](../../../packages/fabrika-cli/src/eval/incident-corpus/ruled-keeps.json)
enumerates it at **66 members plus 1 pending**, and `fabrika eval keeps` prints it with the cases
that already pin each row.
[#4642](https://github.com/kamp-us/phoenix/issues/4642) ruled the corpus and published its size as
74; that figure double-counts the 7 borderline items, and the enumeration supersedes it
([#4823](https://github.com/kamp-us/phoenix/issues/4823)). #4642 and the per-issue verdict table on
[#4634](https://github.com/kamp-us/phoenix/issues/4634) remain the enumeration's provenance, which
`ruled-keeps.json` records in its own `derivation`.

This is the field that makes a stateless session safe. Without it the session re-derives the skill
from its purpose alone and silently re-opens every hole the v1 skill closed the hard way — which is
the one thing a first-principles rebuild is most likely to do.

Two rules keep the field honest:

- **Cite by number, with the behavior stated.** "See the corpus" is not a list. A session cannot
  open the whole corpus and guess which four are its own.
- **A skill with no corpus rows says so explicitly.** An empty list and an unwritten list read the
  same on the page and mean opposite things.

### 4. Prior art — the deterministic layer that already exists, to read and not to call

The existing v1 verbs that already solve some part of this skill's problem, named — as **prior art
to read, never as a runtime to call**. fabrika calls `pipeline-cli` nowhere (CLI interface
convention, rule 6): where v1 already does the work, the session reads its source for the semantics
and the scars it carries, then specifies fabrika's own. The inventory is the
[#4635](https://github.com/kamp-us/phoenix/issues/4635) gap analysis of `packages/pipeline-cli`
(76 tools, verified 2026-08-01).

Naming it is still what stops a session from re-deriving a solved problem from zero — it just changes
what the session does with the answer. Two things a brief should say per entry: what v1's verb
computes, and what it gets *wrong*, because a scar recorded in the old implementation is the cheapest
thing a rebuild can inherit. The pilot found two worth carrying: `adr-sweep` exits non-zero on its
own informative case, and its `--json` payload goes to stderr (#4723). Both were designed out rather
than reproduced.

**Not every entry becomes a verb.** Where the thing is already *enforced* elsewhere — a CI gate, a
merge check — fabrika does not compute a second answer to it. Ask whether the skill needs the answer
or only needs to expect it.

### 5. Conventions — the two pointers, not their content

Every brief points at both, and neither is summarised in the brief:

- [`skill-conventions.md`](skill-conventions.md) — the writing discipline the `SKILL.md` meets
  ([#4653](https://github.com/kamp-us/phoenix/issues/4653)).
- [`cli-interface-convention.md`](cli-interface-convention.md) — what a verb owes its caller, and the
  shape of the contract spec the session emits
  ([#4654](https://github.com/kamp-us/phoenix/issues/4654)).

A brief that paraphrases a convention creates a second source of truth for it, and the paraphrase is
the copy that rots. Point.

### 6. Output contract — one PR, linked back

Stated in the brief itself, so the session reads its own deliverable rather than inferring it:

- **`skill-reviewer` runs on the authored skill *before* the PR opens** — the plugin-dev
  `skill-reviewer` agent is the ruled gate for fabrika skill PRs from day one, and it is **step 5.5
  of the founder's runbook**: author, review, fix the findings, *then* open the PR, which carries the
  review pass ([#4650 build-order ruling](https://github.com/kamp-us/phoenix/issues/4650#issuecomment-5150261966),
  restated as constraint 4 of the [decomposition-dispatch contract](https://github.com/kamp-us/phoenix/issues/4650#issuecomment-5150265328)).
  A session booting from the brief alone reads this here or not at all, so every brief states it —
  and because the gate is `skill-reviewer`, nothing waits on fabrika's own `/review-skill`.
- **One pull request**, carrying the authored `SKILL.md` **and** the derived contract spec
  (`contract.md` beside it, per the CLI interface convention's Part 2).
- **Linked back to the brief issue** — `Fixes #<brief>` in the PR body, so the brief closes on merge
  and the authored artifact is traceable to the document it was authored from.
- **No skill enters fabrika by any other path** ([#4637-C](https://github.com/kamp-us/phoenix/issues/4637)).

**Where the session's job ends.** The PR carries the skill and the *specification* of the verbs it
needs. Implementing those verbs is downstream `write-code` work against that spec — "the crew
implements the contract from there", per the workflow ruling. A session that also implements its
verbs has left its lane; a session that emits no contract spec has skipped its deliverable.

## A brief is not write-code work

A brief issue must never enter the `write-code` candidate pool. If it does, a coder agent picks it
up and implements the skill directly — which is a second door, and the ruling says there is one.

The pool predicate is mechanical
([`step1-candidate-pool.sh`](../../kampus-pipeline/skills/write-code/scripts/step1-candidate-pool.sh)):
**open**, labelled **`status:triaged`** and a priority bucket, and **`assignee == null`**. A brief
could in principle miss the label or hold an assignee — and only one of those two survives the
pipeline that emits it.

**Label-absence does not survive, so the rule may not rest on it.** A brief is minted by `plan-epic`
as an epic child; a child must carry a `status:` label to clear the ledger floor
(`REQUIRED_LABEL_PREFIXES` in
[`validate.ts`](../../../packages/pipeline-cli/src/tools/epic-ledger/validate.ts)), so it is minted
`status:planned`. `review-plan` then flips **every** `status:planned` child of a clean ledger to
`status:triaged` — the filter is that label and nothing else (`plannedChildren` in
[`gate.ts`](../../../packages/pipeline-cli/src/tools/epic-ledger/gate.ts)), with no per-child
exception hook, and the skill states it owns that flip exclusively. So "the planner emits the brief
without `status:triaged`" is undone one stage later, deterministically, for every brief in the
decomposition at once.

**The assignee does survive, so that is the barrier.** Nothing in `plan-epic`, `review-plan` or the
`epic-ledger` gate reads or writes an assignee — the gate's only mutation is the label flip.

> **A brief is emitted assigned**, to the human who will fire its session — applied by `plan-epic` at
> child creation, in the same per-child attribute pass that sets the labels, the milestone and the
> containment marker. An unassigned brief is not a valid brief. The picker steps over it for as long
> as it is open, whatever label `review-plan` puts on it.

The obligation sits on `plan-epic` because `plan-epic` is the one actor that both emits the brief and
can set an attribute nothing downstream undoes.

**The residual gap, stated rather than assumed away.** This is an obligation on the emitting
planner's prompt, not yet a guarantee: `plan-epic` sets no assignee at child creation as written, and
`review-plan` verifies no such invariant — so this contract cannot enforce the rule alone, and today
nothing else does either. Tracked at [#4693](https://github.com/kamp-us/phoenix/issues/4693), which
is where the enforcement shape (planner-applies, plan-gate-verifies, or both) gets decided. It goes
live on the very next run: #4650's decomposition is held until this contract lands and mints 19+
briefs immediately after, so **check the minted briefs' assignees before the pilot returns**.

A repo-wide *guard* on brief board-state is not the near-term answer for the same reason the CLI
convention has no conformance guard: with zero brief issues in existence such a check has zero scope
and reds on itself ([ADR 0092](../../../.decisions/0092-gates-fail-closed-on-zero-scope.md)) —
which is part of what #4693 has to resolve.

## Who writes a brief

`plan-epic`, decomposing a sibling founding epic, emits **one brief per skill** — 19 for the
execution core ([#4650](https://github.com/kamp-us/phoenix/issues/4650)), the same shape for the
ideation quartet ([#4651](https://github.com/kamp-us/phoenix/issues/4651)). This doc is the format
those planners emit against; it emits no briefs itself. Emission carries the board-state obligation
above with it: each brief is created **assigned**, or it is in the coder pool.

## Completeness test

A brief is bootable when all six hold. Each is checkable by reading the brief alone — which is the
point: a session can tell an unbootable brief from a bootable one before it starts authoring.

1. The skill name and its destination directory are both stated.
2. The v1 baseline is a real repo-relative path, or an explicit **none**.
3. Every incident is a number **and** a one-line behavior; an empty list is written as empty.
4. Every prior-art verb is named, with what it computes and — where known — what it gets wrong.
5. Both convention docs are linked, and neither is summarised.
6. The output contract is stated in the brief, not assumed.

## What a brief deliberately does not carry

- **Eval mechanics** — bar, harness, corpus format, protocol, scorecards. Ruled on
  [#4637-B](https://github.com/kamp-us/phoenix/issues/4637) and owned by
  [#4649](https://github.com/kamp-us/phoenix/issues/4649). Field 3 cites incident **issues**, which
  are the corpus's feedstock; it does not author eval cases and does not state a bar.
- **The conventions themselves** — [#4653](https://github.com/kamp-us/phoenix/issues/4653) and
  [#4654](https://github.com/kamp-us/phoenix/issues/4654) own them; field 5 points.
- **The skill's design.** A brief supplies ground, not architecture. Which instructions survive as
  judgment and which become verbs is the two-layer split test the session performs
  (the skill conventions, §1) — a brief that pre-decides it has authored the skill through the
  wrong door.

---

## Worked example — the wave-0 pilot brief

The `/adr` rebuild is fabrika's wave-0 pilot ([#4650](https://github.com/kamp-us/phoenix/issues/4650)).
This is what its brief looks like, at the level of detail the completeness test demands.

**Illustration only.** The real brief issues are emitted by the sibling epics' planning, not by this
doc, and this example pre-commits none of `/adr`'s design.

---

**Skill:** `adr` → `claude-plugins/fabrika/skills/adr/`

**v1 baseline reference:** [`claude-plugins/kampus-pipeline/skills/adr/SKILL.md`](../../kampus-pipeline/skills/adr/SKILL.md)
(181 lines, plus `scripts/`). Reference only — read it for the problem and the scars, not for the
shape. Do not port its scripts (#4638).

**Incidents this rebuild must not regress** (ruled KEEP corpus, `ruled-keeps.json`; #4642):

| Issue | Recorded behavior |
|---|---|
| [#3779](https://github.com/kamp-us/phoenix/issues/3779) | Two concurrent lanes both minted ADR 0198 and both PRs went green (recurrence of the same collision at 0114 and 0123). |
| [#4296](https://github.com/kamp-us/phoenix/issues/4296) | PR #4293 cited unlanded ADR 0219; every gate passed on a dead citation. |
| [#4338](https://github.com/kamp-us/phoenix/issues/4338) | A stale checkout applied a withdrawn ADR 86 minutes after the withdrawal merged. |
| [#4163](https://github.com/kamp-us/phoenix/issues/4163) | A review gate declared a merged ADR nonexistent — four seats, one session. |

The last three are one class read from three angles: **ADR state was resolved against a tree that
was not current**, and the wrong answer was indistinguishable from a right one. #3779 is the
allocation race the v1 skill's reservation lock narrows but does not close.

**Prior art to read, not to call** (#4635 inventory; fabrika calls `pipeline-cli` nowhere — CLI
interface convention rule 6):

- `pipeline-cli decisions-index next` — the next id, `max(id) + 1` zero-padded, parsed from
  `.decisions/` frontmatter.
- `pipeline-cli decisions-index compact` — the `id · title · status` map, ascending by id.
- `pipeline-cli decisions-index validate` — reds on a duplicate id or a filename/frontmatter
  mismatch; this is the CI backstop the number lock relies on.

Read these for semantics and scars; specify fabrika's own. Derive nothing for work that is already
*enforced* somewhere else — a second answer to a gated question is worse than no answer.

**Conventions:** `claude-plugins/fabrika/docs/skill-conventions.md` ·
`claude-plugins/fabrika/docs/cli-interface-convention.md`

**Output contract:** run `skill-reviewer` on the authored skill and fix its findings **before**
opening the PR (runbook step 5.5). Then one PR carrying `claude-plugins/fabrika/skills/adr/SKILL.md`
and `claude-plugins/fabrika/skills/adr/contract.md`, with `Fixes #<this brief>` in the body and the
review pass. The verbs the contract specifies are implemented downstream by `write-code`, against
that spec. No skill enters fabrika by any other path (#4637-C).
