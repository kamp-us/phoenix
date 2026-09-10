# fabrika authoring-brief contract

An **authoring brief** is a GitHub issue: the boot document a fresh session works out of when it
writes one fabrika skill. This doc fixes what a brief carries and what the session owes back.

**Every authoring session works out of a GitHub issue, and every skill gets its own fresh session.**
Freshness is the point: a session that inherits another one's context inherits its assumptions too,
and nothing downstream can tell an assumption from a finding. The bar every rule below serves:

> **A fresh session, given only the brief issue and this repo, can author the skill without asking a
> question and without reading any prior session's transcript.**

## The discipline is `writing-for-agents`, and fabrika builds no tool

fabrika builds no authoring tool. The session writes under
[`writing-for-agents`](../skills/writing-for-agents/SKILL.md). That is the route into
`claude-plugins/fabrika/skills/`, and the rule lives in one place:
[`skill-conventions.md` §8 gate 1](skill-conventions.md#8-the-ship-gate). What fabrika owns is the ground the
writing lands *into* and *against*: this brief format, the skill conventions, and the CLI interface
convention (both in this directory — see [the docs index](README.md)).

A brief still boots its own session, and that has a consequence for how it sits on the board, which
is [its own section](#a-brief-is-not-write-code-work) below.

## Required fields

Six. A brief missing any of them is not bootable, and the session's correct response to an
incomplete brief is to say so on the issue rather than to fill the gap by guessing.

### 1. Skill — the name and where it lands

The skill's name and its destination directory, `claude-plugins/fabrika/skills/<name>/`. One brief,
one skill, one directory.

### 2. Predecessor reference — a path, and nothing more

The repo-relative path of the skill this one replaces — for a skill with no predecessor, an explicit
**none**.

**It is reference, never source of truth.** The session reads it to learn what problems the skill
solves and what scars it carries; it does not port it, mirror its structure, or treat its shell
scripts as the contract.

### 3. Incidents — what the rebuild must not regress

The rows from the repo's ruled incident corpus that bear on this skill, each as a number plus the
one-line behaviour it records. The corpus lives on the tracker, not in the repo, so a brief names
where it is read from rather than mirroring it — a committed copy of a live corpus goes stale with
nothing marking it.

Two rules keep the field honest:

- **Cite by number, with the behaviour stated.** "See the corpus" is not a list.
- **A skill with no corpus rows says so explicitly.** An empty list and an unwritten list read the
  same on the page and mean opposite things.

### 4. Prior art — the deterministic layer that already exists, to read and not to call

The existing verbs that already solve some part of this skill's problem, named — as **prior art to
read, never as a runtime to call**. fabrika calls nothing outside fabrika (CLI interface convention,
rule 6). Per entry, a brief states what the predecessor's verb computes and — where known — what it
gets *wrong*. Two scars worth recording as the shape of the field: a verb that exits non-zero on its
own informative case, and a verb whose `--json` payload goes to stderr. Both are designed out rather
than reproduced.

**Not every entry becomes a verb.** Where the thing is already *enforced* elsewhere — a CI gate, a
merge check — the skill expects the answer rather than computing a second one.

### 5. Conventions — the two pointers, not their content

Every brief points at both, and neither is summarised in the brief:

- [`skill-conventions.md`](skill-conventions.md) — the writing discipline the `SKILL.md` meets.
- [`cli-interface-convention.md`](cli-interface-convention.md) — what a verb owes its caller, and the
  shape of the contract spec the session emits.

A brief points; it never paraphrases a convention into the brief.

### 6. Output contract — one PR, linked back

Stated in the brief itself:

- **`skill-reviewer` runs on the authored skill *before* the PR opens** — the plugin-dev
  `skill-reviewer` agent is the gate for fabrika skill PRs: author, review, fix the findings, *then*
  open the PR, which carries the review pass. Every brief states this, and nothing waits on a
  fabrika-side review of the same artifact.
- **The calibration inputs are handed over, and the hand-off is written down as it happens.**
  `skill-reviewer` is a generic upstream `plugin-dev` agent, handed fabrika's conventions by nothing,
  so the session hands it [`skill-conventions.md`](skill-conventions.md) and a landed sibling skill,
  and **names those inputs in the PR body** at the moment of the hand-off. Recording it at the
  hand-off rather than reconstructing it later is what keeps the record a fact instead of a claim.
- **One pull request**, carrying the authored `SKILL.md` **and** the derived contract spec
  (`contract.md` beside it, per the contract-spec format).
- **Linked back to the brief issue** — `Fixes #<brief>` in the PR body, so the brief closes on merge
  and the authored artifact is traceable to the document it was authored from.
- **No line target, and no sizing acceptance criterion.** Sizing is `skill-conventions.md` §2's
  structural split — `SKILL.md` routes, `contract.md` carries the depth — judged case by case by
  the gate.

**Where the session's job ends.** The PR carries the skill and the *specification* of the verbs it
needs. Implementing those verbs is downstream `write-code` work against that spec. A session neither
implements its verbs nor skips emitting the contract spec.

**Who files the implementation ticket: this session, at handoff.** The lane ends at the spec, but
the *hand-off* is the session's, and it is not complete until the implementation ticket exists and
the handoff names its number. A machine cannot mint it, because only the session knows what it
derived. The ticket carries, at minimum: the skill it serves, the repo-relative path of its
`contract.md`, the verb inventory, and any sequencing dependency on the verb package existing. It
goes through triage like any other issue; the session files it and stops.

**It is checked, not merely asked for.** `review-skill` lists this as a criterion on a PR that adds
or changes a `contract.md`: the implementation ticket must exist, be open, and be named in the PR
body or the handoff comment. The brief's own `Fixes #<brief>` line does **not** satisfy it — that is
a done-signal for the brief, not the hand-off. Two seams have already been lost to nobody noticing
that difference, which is why the check exists rather than the expectation.

## A brief is not write-code work

A brief issue never enters the `write-code` candidate pool: a brief specifies an authoring session's
inputs and is fired by a human starting that session — it is not a build ticket. **A brief is
emitted assigned**, to the human who will fire its session, applied by `plan-epic` at child
creation; an unassigned brief is not a valid brief, and the picker steps over it for as long as it
is open.

Assignment, not label-absence, is the barrier: the plan gate flips every planned child to triaged
with no per-child exception, while the assignee is the one attribute nothing downstream touches. A
repo-wide guard on brief board-state is ruled out on zero-scope grounds — it would judge a pool that
is usually empty, and a gate that scanned nothing is a gate that reds on itself (interface
convention, rule 4).

## Who writes a brief

`plan-epic`, decomposing a founding epic, emits **one brief per skill**. This doc is the format
those planners emit against; it emits no briefs itself. Each brief is created **assigned**
([a brief is not write-code work](#a-brief-is-not-write-code-work)).

## Completeness test

A brief is bootable when all six hold. Each is checkable by reading the brief alone.

1. The skill name and its destination directory are both stated.
2. The predecessor reference is a real repo-relative path, or an explicit **none**.
3. Every incident is a number **and** a one-line behaviour; an empty list is written as empty.
4. Every prior-art verb is named, with what it computes and — where known — what it gets wrong.
5. Both convention docs are linked, and neither is summarised.
6. The output contract is stated in the brief, not assumed — including its filing half (the
   handoff mints the implementation ticket and names its number) and its calibration half (the PR
   records which inputs `skill-reviewer` was handed).

## What a brief deliberately does not carry

- **Eval mechanics** — bar, harness, corpus format, protocol, scorecards. Field 3 cites incident
  **issues**, which are the corpus's feedstock; it does not author eval cases and does not state a
  bar.
- **The conventions themselves** — field 5 points at them and stops.
- **The skill's design.** A brief supplies ground, not architecture. Which instructions survive as
  judgment and which become verbs is the two-layer split test the session performs
  (the skill conventions, §1).

---

## Worked example

**Illustration only.** Real brief issues are emitted by an epic's planning, not by this doc, and
this example pre-commits none of the named skill's design. It shows a brief at the level of detail
the completeness test demands; every `#<n>` below stands for a real number the emitting planner
fills in.

---

**Skill:** `adr` → `claude-plugins/fabrika/skills/adr/`

**Predecessor reference:** the replaced skill's `SKILL.md` (181 lines, plus `scripts/`). Reference
only — read it for the problem and the scars, not for the shape. Do not port its scripts.

**Incidents this rebuild must not regress** (from the repo's ruled incident corpus):

| Issue | Recorded behaviour |
|---|---|
| `#<n>` | Two concurrent lanes both minted the same decision id and both PRs went green — the third recurrence of that collision. |
| `#<n>` | A PR cited an unlanded decision record; every gate passed on a dead citation. |
| `#<n>` | A stale checkout applied a withdrawn decision 86 minutes after the withdrawal merged. |
| `#<n>` | A review gate declared a merged decision nonexistent — four seats, one session. |

The last three are one class read from three angles: **decision state was resolved against a tree
that was not current**, and the wrong answer was indistinguishable from a right one. The first is
the allocation race a reservation lock narrows but does not close.

**Prior art, and where it went.** The predecessor's `decisions-index` was deleted with its package,
so there is no longer a second implementation to read — only what fabrika ships:

- the next id, `max(id) + 1` zero-padded, parsed from the decision corpus's frontmatter →
  `fabrika adr next`.
- reds on a duplicate id or a filename/frontmatter mismatch, the CI backstop the number lock relies
  on → `fabrika guard decisions-index validate`.
- the `id · title · status` map, ascending by id → **nothing ships this**; the brief names the ticket
  that tracks it.

Derive nothing for work that is already *enforced* somewhere else — a second answer to a gated
question is worse than no answer.

**Conventions:** `claude-plugins/fabrika/docs/skill-conventions.md` ·
`claude-plugins/fabrika/docs/cli-interface-convention.md`

**Output contract:** run `skill-reviewer` on the authored skill and fix its findings **before**
opening the PR. Then one PR carrying `claude-plugins/fabrika/skills/adr/SKILL.md` and
`claude-plugins/fabrika/skills/adr/contract.md`, with `Fixes #<brief>` in the body and the review
pass. The verbs the contract specifies are implemented downstream by `write-code`, against that spec
— and this session's handoff files that implementation ticket and names its number in the PR body.
The skill is written under `writing-for-agents`, per skill-conventions §8 gate 1.
