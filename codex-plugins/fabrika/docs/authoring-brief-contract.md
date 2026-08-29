# fabrika authoring-brief contract

An **authoring brief** is a GitHub issue: the boot document a fresh session works out of when it
writes one fabrika skill. This doc fixes what a brief carries and what the session owes back.

**Every authoring session works out of a GitHub issue, and every skill gets its own fresh
session** — founder workflow ruling, recorded on
[#4650](https://github.com/kamp-us/phoenix/issues/4650#issuecomment-5150192649), which also holds
the why of the freshness. The bar every rule below serves:

> **A fresh session, given only the brief issue and this repo, can author the skill without asking a
> question and without reading any prior session's transcript.**

## The discipline is `writing-for-agents`, and fabrika builds no tool

fabrika builds no authoring tool — [#4648 scope
correction](https://github.com/kamp-us/phoenix/issues/4648#issuecomment-5152523719). The session
writes under [`writing-for-agents`](../skills/writing-for-agents/SKILL.md). That is the route into
`claude-plugins/fabrika/skills/`, and the rule and its history live in one place:
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

### 2. v1 baseline reference — a path, and nothing more

The repo-relative path of the v1 skill this one replaces, under
`../../kampus-pipeline/skills/` — for a skill with no v1 ancestor,
an explicit **none**.

**It is reference, never source of truth** ([#4638
ruling](https://github.com/kamp-us/phoenix/issues/4638)). The session reads it to learn what
problems the skill solves and what scars it carries; it does not port it, mirror its structure, or
treat its shell scripts as the contract.

### 3. Incidents — what the rebuild must not regress

The rows from the **ruled KEEP corpus** that bear on this skill, each as a number plus the one-line
behavior it records. The corpus lives on the tracker, not in the repo: [#4642](https://github.com/kamp-us/phoenix/issues/4642)
ruled it and the per-issue verdict table on
[#4634](https://github.com/kamp-us/phoenix/issues/4634) enumerates it. #4642 published the size as
74; that figure double-counts the 7 borderline items, and the real membership is **66 plus 1
pending** ([#4823](https://github.com/kamp-us/phoenix/issues/4823)). The committed enumeration that
used to mirror those two issues went out with the eval tooling
([#5510](https://github.com/kamp-us/phoenix/issues/5510)), so read them directly.

Two rules keep the field honest:

- **Cite by number, with the behavior stated.** "See the corpus" is not a list.
- **A skill with no corpus rows says so explicitly.** An empty list and an unwritten list read the
  same on the page and mean opposite things.

### 4. Prior art — the deterministic layer that already exists, to read and not to call

The existing v1 verbs that already solve some part of this skill's problem, named — as **prior art
to read, never as a runtime to call**. fabrika calls `pipeline-cli` nowhere (CLI interface
convention, rule 6); the read-don't-call posture and its price live in
[ADR 0238](../../../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md). Per entry, a brief
states what v1's verb computes and — where known — what it gets *wrong*. The inventory is the
[#4635](https://github.com/kamp-us/phoenix/issues/4635) gap analysis of `packages/pipeline-cli`
(76 tools, verified 2026-08-01). The pilot found two scars worth carrying: `adr-sweep` exits
non-zero on its own informative case, and its `--json` payload goes to stderr (#4723). Both were
designed out rather than reproduced.

**Not every entry becomes a verb.** Where the thing is already *enforced* elsewhere — a CI gate, a
merge check — the skill expects the answer rather than computing a second one.

### 5. Conventions — the two pointers, not their content

Every brief points at both, and neither is summarised in the brief:

- [`skill-conventions.md`](skill-conventions.md) — the writing discipline the `SKILL.md` meets
  ([#4653](https://github.com/kamp-us/phoenix/issues/4653)).
- [`cli-interface-convention.md`](cli-interface-convention.md) — what a verb owes its caller, and the
  shape of the contract spec the session emits
  ([#4654](https://github.com/kamp-us/phoenix/issues/4654)).

A brief points; it never paraphrases a convention into the brief.

### 6. Output contract — one PR, linked back

Stated in the brief itself:

- **`skill-reviewer` runs on the authored skill *before* the PR opens** — the plugin-dev
  `skill-reviewer` agent is the ruled gate for fabrika skill PRs from day one, and it is **step 5.5
  of the founder's runbook**: author, review, fix the findings, *then* open the PR, which carries the
  review pass ([#4650 build-order ruling](https://github.com/kamp-us/phoenix/issues/4650#issuecomment-5150261966),
  restated as constraint 4 of the [decomposition-dispatch contract](https://github.com/kamp-us/phoenix/issues/4650#issuecomment-5150265328)).
  Every brief states this; the gate is `skill-reviewer`, so nothing waits on fabrika's own
  `/review-skill`.
- **The calibration inputs are handed over, and the hand-off is written down as it happens.**
  The session hands `skill-reviewer` — a generic upstream `plugin-dev` agent handed fabrika's
  conventions by nothing ([#4701](https://github.com/kamp-us/phoenix/issues/4701)) —
  [`skill-conventions.md`](skill-conventions.md) and a landed sibling skill, and **names those
  inputs in the PR body during step 5.5**
  ([ADR 0270](../../../.decisions/0270-calibration-record-is-written-at-the-handoff.md), which owns
  the record-not-act wording and the price of verb-mediating it instead). Briefs already minted
  carry the older *"was handed … as calibration"* wording and are read at this same evidence class.
- **One pull request**, carrying the authored `SKILL.md` **and** the derived contract spec
  (`contract.md` beside it, per the CLI interface convention's Part 2).
- **Linked back to the brief issue** — `Fixes #<brief>` in the PR body, so the brief closes on merge
  and the authored artifact is traceable to the document it was authored from.
- **No line target, and no sizing acceptance criterion.** Sizing is `skill-conventions.md` §2's
  structural split — `SKILL.md` routes, `contract.md` carries the depth — judged case by case by
  the gate ([#4701](https://github.com/kamp-us/phoenix/issues/4701#issuecomment-5234580426)).

**Where the session's job ends.** The PR carries the skill and the *specification* of the verbs it
needs. Implementing those verbs is downstream `write-code` work against that spec — "the crew
implements the contract from there", per the workflow ruling. A session neither implements its verbs
nor skips emitting the contract spec.

**Who files the implementation ticket: this session, at handoff.** The lane ends at the spec, but
the *hand-off* is the session's, and it is not complete until the implementation ticket exists and
the handoff names its number
([ADR 0248](../../../.decisions/0248-authoring-session-mints-the-implementation-ticket.md) — which
also rules out machine-minting and holds the filer choice). The ticket carries, at minimum: the
skill it serves, the repo-relative path of its `contract.md`, the verb inventory, and any sequencing
dependency on the verb package existing. It goes through triage like any other issue; the session
files it and stops.

**It is checked, not merely asked for.** `review-skill` lists this as a criterion on a PR that adds
or changes a `contract.md`: the implementation ticket must exist, be open, and be named in the PR
body or the handoff comment. The brief's own `Fixes #<brief>` line does **not** satisfy it — that is
a done-signal for the brief, not the hand-off. The two seams already lost to somebody noticing are
recorded in [ADR 0248](../../../.decisions/0248-authoring-session-mints-the-implementation-ticket.md)
(#4725, #4748).

## A brief is not write-code work

A brief issue never enters the `write-code` candidate pool: a brief specifies an authoring session's
inputs and is fired by a human starting that session — it is not a build ticket. **A brief is
emitted assigned**, to the human who will fire its session, applied by `plan-epic` at child
creation; an unassigned brief is not a valid brief, and the picker steps over it for as long as it
is open.

Assignment, not label-absence, is the barrier: `review-plan` flips every `status:planned` child to
`status:triaged` with no per-child exception, while the assignee is the one attribute nothing
downstream touches. The reasoning lives in the founder rulings on
[#4650](https://github.com/kamp-us/phoenix/issues/4650) and the open enforcement gap is tracked at
[#4693](https://github.com/kamp-us/phoenix/issues/4693); a repo-wide guard on brief board-state is
ruled out on zero-scope grounds in
[ADR 0092](../../../.decisions/0092-gates-fail-closed-on-zero-scope.md).

## Who writes a brief

`plan-epic`, decomposing a sibling founding epic, emits **one brief per skill** — 19 for the
execution core ([#4650](https://github.com/kamp-us/phoenix/issues/4650)), the same shape for the
ideation quartet ([#4651](https://github.com/kamp-us/phoenix/issues/4651)). This doc is the format
those planners emit against; it emits no briefs itself. Each brief is created **assigned**
([a brief is not write-code work](#a-brief-is-not-write-code-work)).

## Completeness test

A brief is bootable when all six hold. Each is checkable by reading the brief alone.

1. The skill name and its destination directory are both stated.
2. The v1 baseline is a real repo-relative path, or an explicit **none**.
3. Every incident is a number **and** a one-line behavior; an empty list is written as empty.
4. Every prior-art verb is named, with what it computes and — where known — what it gets wrong.
5. Both convention docs are linked, and neither is summarised.
6. The output contract is stated in the brief, not assumed — including its filing half (the
   handoff mints the implementation ticket and names its number) and its calibration half (the PR
   records which inputs `skill-reviewer` was handed).

## What a brief deliberately does not carry

- **Eval mechanics** — bar, harness, corpus format, protocol, scorecards. Ruled on
  [#4637-B](https://github.com/kamp-us/phoenix/issues/4637) and owned by
  [#4649](https://github.com/kamp-us/phoenix/issues/4649). Field 3 cites incident **issues**, which
  are the corpus's feedstock; it does not author eval cases and does not state a bar.
- **The conventions themselves** — [#4653](https://github.com/kamp-us/phoenix/issues/4653) and
  [#4654](https://github.com/kamp-us/phoenix/issues/4654) own them; field 5 points.
- **The skill's design.** A brief supplies ground, not architecture. Which instructions survive as
  judgment and which become verbs is the two-layer split test the session performs
  (the skill conventions, §1).

---

## Worked example — the wave-0 pilot brief

The `/adr` rebuild is fabrika's wave-0 pilot ([#4650](https://github.com/kamp-us/phoenix/issues/4650)).
This is what its brief looks like, at the level of detail the completeness test demands.

**Illustration only.** The real brief issues are emitted by the sibling epics' planning, not by this
doc, and this example pre-commits none of `/adr`'s design.

---

**Skill:** `adr` → `claude-plugins/fabrika/skills/adr/`

**v1 baseline reference:** `claude-plugins/kampus-pipeline/skills/adr/SKILL.md`
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

**Prior art, and where it went** (#4635 inventory). v1's `decisions-index` was deleted with its
package (#6100), so there is no longer a second implementation to read — only what fabrika ships:

- the next id, `max(id) + 1` zero-padded, parsed from `.decisions/` frontmatter → `fabrika adr next`.
- reds on a duplicate id or a filename/frontmatter mismatch, the CI backstop the number lock relies
  on → `fabrika guard decisions-index validate`.
- the `id · title · status` map, ascending by id → **nothing ships this**; #6332 tracks it.

Derive nothing for work that is already *enforced* somewhere else — a second answer to a gated
question is worse than no answer.

**Conventions:** `claude-plugins/fabrika/docs/skill-conventions.md` ·
`claude-plugins/fabrika/docs/cli-interface-convention.md`

**Output contract:** run `skill-reviewer` on the authored skill and fix its findings **before**
opening the PR (runbook step 5.5). Then one PR carrying `claude-plugins/fabrika/skills/adr/SKILL.md`
and `claude-plugins/fabrika/skills/adr/contract.md`, with `Fixes #<this brief>` in the body and the
review pass. The verbs the contract specifies are implemented downstream by `write-code`, against
that spec — and this session's handoff files that implementation ticket and names its number in the
PR body (ADR 0248). The skill is written under `writing-for-agents`, per skill-conventions §8 gate 1.
