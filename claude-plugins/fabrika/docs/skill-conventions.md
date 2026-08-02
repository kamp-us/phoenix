# fabrika skill conventions

The writing discipline every fabrika skill meets. A `/skill-creator` session authors against this
doc; the skill-reviewer gate holds a skill to it.

These conventions are **skill-agnostic**. The execution core, the ideation layer, and every skill
after them are consumers on identical terms — there is no per-skill exemption and no
special-casing. If a rule cannot hold for some skill, that is a defect in the rule, to be fixed
here for everyone.

Every convention below names the ruling or survey it came from, because none of them are
self-evident and a rule with no cited source is one nobody can re-check. The two external sources
are the SOTA reference (`mattpocock/skills`, read at `2ab9580`) surveyed on
[#4644](https://github.com/kamp-us/phoenix/issues/4644), and the founder rulings recorded on
wayfinder:map [#4631](https://github.com/kamp-us/phoenix/issues/4631).

## 1. The two-layer split

**Every skill splits into two layers.** The deterministic parts are pushed **maximally** into
Effect CLI verbs; the skill itself is a thin wrapper that hands the model those verbs and carries
**only the judgment the deterministic layer cannot**. The target is a pipeline that is as
deterministic as it can be made, with the stochastic surface reduced to what genuinely needs a
model.

This is the load-bearing rule — the sizing, the invocation shape, and the ship gate below are all
downstream of it. The operative test when authoring: for each instruction in the draft, ask
whether a verb could decide it. If yes, it does not belong in the skill; derive the verb.

v1 is the counter-example the split exists to escape: its deterministic layer was hand-waved shell
scripts rather than typed, tested verbs.

> Source: founder ruling on [#4631](https://github.com/kamp-us/phoenix/issues/4631) (v2
> architecture, in-session 2026-08-01).

## 2. Sizing — the tiny wrapper

**7–140 lines, median ~75.** A fabrika `SKILL.md` that runs past the band is not "thorough", it is
un-split: the overflow is deterministic content that should have become a verb (§1) or reference
that should have moved behind a pointer (§5).

The band is not an aesthetic preference. It is the measured shape of the SOTA reference's 41
skills, against which v1's own skills trend **300–600** lines (its `wayfinder` is 579). That gap is
the discipline v1 lacked, stated as a number so it can be checked instead of felt.

Finer division is not free, and §3 is the ledger for what it costs.

> Source: [#4644](https://github.com/kamp-us/phoenix/issues/4644) survey finding (measured across
> the reference at `2ab9580`), adopt-list item 3.

## 3. Invocation-axis economics

A skill's **invocation axis** is a design lever with a price on both settings, and picking one
without pricing it is how a skill corpus becomes unusable at scale.

- **Model-invoked** — the skill keeps its `description`, so the model can discover and fire it on
  its own, and another skill can invoke it. It pays a **context load** on every turn, forever:
  the description spends tokens and, more expensively, attention.
- **User-invoked** — the `description` is stripped. Zero context load, but nothing except a human
  typing its name can reach it, including other skills. The cost moves to the human as
  **cognitive load**: they must remember the skill exists and when to reach for it.

**Choose model-invoked only when the model must reach the skill unprompted.** A skill that only
ever fires by hand should carry no description and pay no context load.

**The two loads are the brakes on granularity.** More model-invoked skills crowd the context
window; more user-invoked skills crowd the human. When user-invoked skills multiply past what a
human can hold, the cure is a **router skill** — a user-invoked skill naming the others and when to
reach for each — not a description bolted back onto each one.

Cognitive load is **not** a cost to minimise to zero: it is the price of human agency, and it is
correctly spent where human judgment matters.

> Source: [#4644](https://github.com/kamp-us/phoenix/issues/4644) adopt-list item 1, grounded in
> the reference's `.agents/invocation.md` and `skills/productivity/writing-great-skills/GLOSSARY.md`
> at `2ab9580`.

## 4. The invocation surface is a plain literal

**Every command a fabrika skill tells the model to run is a plain literal string** — no variable
expansion, no default-expansion, no `..` climb.

This is a hard constraint from the harness, not a style call. The isolation verifier that gates an
isolated agent's commands is a **syntactic check on the command string**: it consults neither the
process environment nor the filesystem. A genuinely-set `$CLAUDE_PLUGIN_ROOT` is refused; so are
`$USER` and `$PWD` while set; a symlink whose target does not exist runs fine as an ordinary
`ENOENT`. So **no environment-injection mechanism of any kind can make a variable-addressed
invocation work** — the failure is in the expansion, not in availability, and no re-test will
change it.

A `pipeline-cli <verb> …`-style invocation — a bare command name followed by literal arguments —
satisfies this **by construction**, carrying no path expansion at all. (The shape is what is
adopted, not that package: where fabrika's own verbs live is deferred to the first derived
contract.) That is a second reason the two-layer split pays: pushing mechanics into verbs
produces exactly the invocation shape the harness permits, where a path-addressed script has to be
made to fit.

Caveat carried from the probe record: one host, unpinned CLI version — reproducible, but not
proven universal. Re-check on a harness-version bump using the probe discipline recorded on
[#4641](https://github.com/kamp-us/phoenix/issues/4641) (a must-refuse and a must-run control in
the same session, one shape per call).

> Source: [#4641](https://github.com/kamp-us/phoenix/issues/4641), carried onto
> [#4631](https://github.com/kamp-us/phoenix/issues/4631) as the v2 consequence.

## 5. Skill-quality vocabulary and the failure-mode taxonomy

fabrika adopts the reference's vocabulary wholesale, because a named failure mode is one an author
and a reviewer can both point at. The root virtue is **predictability** — the skill makes the model
behave the same *way* every run (the same process, not the same output). Every term below is a
lever on it, and every failure mode sits beside the lever that cures it.

**Information hierarchy** — content ranked by how immediately the model needs it: steps in-file
first, then in-file reference, then reference disclosed behind a **context pointer**. **Progressive
disclosure** is the act of moving reference down that ladder; it protects the hierarchy, and saving
tokens is a side effect, not the point. **Co-location** is its within-file companion: a concept's
definition, rules, and caveats sit under one heading rather than scattered.

**Leading word** — a compact concept already in the model's pretraining that the skill repeats *as
a token, never as a sentence*, so it accumulates a distributed definition and anchors a region of
behaviour. Reach for a pretrained word first: a coined one recruits no priors, so you pay in
definition tokens what an existing word gives free.

The failure modes, each with its cure:

| Failure mode | What it is | Cure |
|---|---|---|
| **Premature completion** | ending a step before it is genuinely done, because attention slips to *being done* | sharpen the completion criterion first (local, cheap); hide later steps only if the bound is irreducibly fuzzy **and** the rush is actually observed |
| **Sprawl** | length itself — too many lines, whatever the cause | push reference down the hierarchy; split by branch or sequence |
| **Sediment** | stale layers that accumulate because adding feels safe and removing feels risky | a pruning discipline; the **relevance** test — does this line still bear on the task? |
| **Duplication** | one meaning given more than one home | single source of truth; note it is the accidental inverse of a leading word, which repeats a *token* on purpose, never a meaning |
| **No-op** | an instruction the model would follow by default — load paid for nothing | the behaviour-versus-default test; a leading word too weak to beat the default is a no-op, and the fix is a stronger word |
| **Negation** | steering by prohibition, which drags the forbidden behaviour into context and makes it *more* available | prompt the positive target; a ban earns its place only as a guardrail on something unphraseable positively, and even then pairs with the positive |

`no-op` is deliberately **model-relative**: two reviewers disagreeing over whether a line is a no-op
disagree about the model's default, and settle it by running the skill — not by argument.

> Source: [#4644](https://github.com/kamp-us/phoenix/issues/4644) adopt-list item 2, grounded in
> `skills/productivity/writing-great-skills/{SKILL,GLOSSARY}.md` at `2ab9580`. The reference's
> definitions are adopted as-is; fabrika adds no synonyms.

## 6. Checkable completion criteria

**Every step ends on a completion criterion, and the criterion is checkable.** "Understanding
reached" is not a criterion; "every modified model accounted for" is.

A criterion carries two independent properties, and conflating them costs one of the two:

- **Clarity** — can the model tell done from not-done? This is what resists **premature
  completion**, and it needs steps to bite.
- **Demand** — how much the criterion requires. This sets how much **legwork** the model does
  inside the step, and it is *not* step-bound: a demand can bind a body of flat reference too,
  which is how a skill with no steps still carries an exhaustiveness bar ("every rule applied").

**The strongest criteria are both checkable and exhaustive**, and a fabrika skill aims for both.

> Source: [#4644](https://github.com/kamp-us/phoenix/issues/4644) adopt-list item 2 (the
> completion-criterion lever from the reference's glossary at `2ab9580`).

## 7. The scope law — `.out-of-scope/`

**A rejected proposal is recorded, with its reasoning, so it stops being re-proposed.** fabrika
keeps an `.out-of-scope/` directory at the plugin root: one file per rejected proposal, named for
the proposal, stating what is out of scope, **why**, and what prior requests asked for it.

This is a first-class scope law rather than a courtesy. An unrecorded rejection is one the next
session re-derives from zero and may re-decide differently; a recorded one is a decision that holds
without anyone remembering it. It is the same instinct as `.decisions/` — the repo's ADRs record
what *was* decided, and `.out-of-scope/` records what was decided **against** at the skill layer.

A rejection belongs here when it is a real proposal someone could plausibly make again — not every
idea that was passed over in an authoring session.

> Source: [#4644](https://github.com/kamp-us/phoenix/issues/4644) adopt-list item 4, grounded in
> the reference's `.out-of-scope/` at `2ab9580`.

## 8. The ship gate

A fabrika skill ships when **all three** hold — no exceptions, no partial credit:

1. **Authored via `/skill-creator`**, against these conventions. This is the only door: not
   hand-dropped into `skills/`, not ported from v1, not copied from a sibling plugin. See the
   [fabrika README](../README.md) for the posture.
2. **Its derived CLI contract is implemented with deterministic tests.** The authoring session
   derives the CLI API the skill needs, and *that spec is the contract* the verbs implement — the
   v1 scripts are never the source of truth, so there is no port to grade against.
3. **Its eval set is green at the bar.** The bar's numbers are ruled on
   [#4637-B](https://github.com/kamp-us/phoenix/issues/4637); the harness, corpus, and protocol
   that measure against it are owned by [#4649](https://github.com/kamp-us/phoenix/issues/4649).
   **This doc specifies none of that mechanics and must not grow it** — a convention doc that
   restates the bar becomes a second source of truth for a number that moves.

Gates 1 and 2 are what this doc governs. Gate 3 is cited, never re-derived here.

> Source: founder ruling [#4637-C](https://github.com/kamp-us/phoenix/issues/4637) (confirmed
> in-session 2026-08-01), with the contract-driven method from
> [#4638](https://github.com/kamp-us/phoenix/issues/4638) (no blanket port of the v1 scripts).

## What these conventions deliberately do not cover

- **What a verb owes its caller** — `--help` discoverability, output contracts, usage examples —
  and the shape of a derived contract spec: the CLI interface convention
  ([#4654](https://github.com/kamp-us/phoenix/issues/4654)).
- **The boot document a stateless authoring session works from**: the authoring-brief contract
  ([#4655](https://github.com/kamp-us/phoenix/issues/4655)).
- **Any eval mechanics** — bar, harness, corpus, protocol, scorecards
  ([#4637-B](https://github.com/kamp-us/phoenix/issues/4637) /
  [#4649](https://github.com/kamp-us/phoenix/issues/4649)), as §8 states.

## What fabrika does not take from the reference

The SOTA reference is SOTA on skill-**writing** theory, and that is the whole of what is adopted
above. It carries **no eval harness, no test cases, no regression discipline, no authoring
workflow, and no deterministic tool layer** — its mechanics are embedded shell-and-`gh` prose,
which is precisely the shape the two-layer split (§1) exists to escape.

So the borrowing is one-directional and bounded: **take the vocabulary, the sizing, and the
invocation economics; keep our execution substrate.** Neither source arrives on authority.

> Source: [#4644](https://github.com/kamp-us/phoenix/issues/4644) SKIP list and its calibration
> note (v2's two-layer split and eval-backed givens are ahead of the reference).
