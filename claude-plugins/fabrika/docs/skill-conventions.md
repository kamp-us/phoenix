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
wayfinder:maps [#4631](https://github.com/kamp-us/phoenix/issues/4631) and
[#4891](https://github.com/kamp-us/phoenix/issues/4891).

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

**`SKILL.md` is a routing and orientation surface; depth lives in `contract.md`.** The skill says
what the thing is, when to fire it, and where each step's detail lives — the detail itself sits
behind the pointer. **A `SKILL.md` that inlines what its contract owns is the defect**, and that is
the same un-split failure §1 names: the overflow is deterministic content that should have become a
verb, or reference that should have moved behind a pointer (§5).

**There is no line count.** Concision is judged case by case against that split — never "how long is
it", always "does this paragraph belong here or in the contract". A skill that has honoured the
split is short as a consequence, not as a target, and shortness reached by deleting judgement is not
conformance.

Finer division is not free, and §3 is the ledger for what it costs.

> Source: founder-delegated ruling on
> [#4701](https://github.com/kamp-us/phoenix/issues/4701#issuecomment-5234580426), jointly with
> [#5219](https://github.com/kamp-us/phoenix/issues/5219), deleting the prior 7–140 line band drawn
> from the [#4644](https://github.com/kamp-us/phoenix/issues/4644) survey: it was unenforceable by
> the ruled gate, which judges qualitatively, and violated by most of the landed corpus.

## 3. Invocation-axis economics

A skill's **invocation axis** is a design lever with a price on both settings, and picking one
without pricing it is how a skill corpus becomes unusable at scale.

- **Model-invoked** — the skill keeps its `description`, so the model can discover and fire it on
  its own, including as the next step another skill's text directs it to take. It pays a **context
  load** on every turn, forever: the description spends tokens and, more expensively, attention.
- **User-invoked** — the `description` is stripped (`disable-model-invocation`). Zero context load,
  and three costs, not one. The skill is **model-unreachable**: nothing but a human typing its name
  starts it. It **breaks a skill stack**: it cannot be one link in a chain, because the model is
  what advances a stack. And it **cannot be preloaded into a subagent** through a `skills:`
  manifest, so no dispatched lane can carry it. The remaining cost lands on the human as
  **cognitive load**: they must remember the skill exists and when to reach for it.

**Skills cannot invoke skills.** No skill programmatically calls another. Composition is the
*model* firing the next Skill tool as a skill's text directs, or a human stacking skills by hand —
so the invocation axis decides who can reach a skill, the model or only a human, and never whether
a sibling skill can call it.

**Choose model-invoked only when the model must reach the skill unprompted.** A skill that only
ever fires by hand should carry no description and pay no context load.

**The two loads are the brakes on granularity.** More model-invoked skills crowd the context
window; more user-invoked skills crowd the human. When user-invoked skills multiply past what a
human can hold, the cure is a **router skill** — a user-invoked skill naming the others and when to
reach for each — not a description bolted back onto each one.

**That cure carries the full user-only cost, and this doc used to leave it unpriced.** A router is
user-invoked, so it is model-unreachable, cannot join a stack, and cannot be preloaded into a
subagent. A corpus whose entry point is a router is a corpus no unattended session can enter on its
own: the router serves an operator at a keyboard and serves an agent-driven lane not at all. Which
composition mechanism is fabrika's actual front door is open on
[#4903](https://github.com/kamp-us/phoenix/issues/4903); until it is ruled, name the router's cost
whenever you reach for it.

Cognitive load is **not** a cost to minimise to zero: it is the price of human agency, and it is
correctly spent where human judgment matters.

> Source: [#4644](https://github.com/kamp-us/phoenix/issues/4644) adopt-list item 1, grounded in
> the reference's `.agents/invocation.md` and `skills/productivity/writing-great-skills/GLOSSARY.md`
> at `2ab9580`.
>
> Amended 2026-08-08, from the confirmed skill-system mechanics seeded on
> [#4903](https://github.com/kamp-us/phoenix/issues/4903): two corrections, both to statements this
> section previously made. It said another skill could invoke a model-invoked skill — skills cannot
> invoke skills. And it priced the user-invoked axis as human cognitive load alone, leaving the
> stack and subagent-preload costs — and therefore the router cure's real price — unstated.

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

A fabrika skill ships when **both** hold — no exceptions, no partial credit:

1. **Authored via `/skill-creator`**, against these conventions. This is the only door: not
   hand-dropped into `skills/`, not ported from v1, not copied from a sibling plugin. See the
   [fabrika README](../README.md) for the posture.
2. **Its derived CLI contract is implemented with deterministic tests.** The authoring session
   derives the CLI API the skill needs, and *that spec is the contract* the verbs implement — the
   v1 scripts are never the source of truth, so there is no port to grade against.

Both gates are what this doc governs.

> Source: founder ruling [#4637-C](https://github.com/kamp-us/phoenix/issues/4637) (confirmed
> in-session 2026-08-01), with the contract-driven method from
> [#4638](https://github.com/kamp-us/phoenix/issues/4638) (no blanket port of the v1 scripts).

## 9. Trust and ingestion

A fabrika skill runs with a shell, a token, and a path to `main`, and it reads text that anyone
with a GitHub account can author. These five rules are the shared vocabulary every authoring brief
states its own answers in, so that what a skill reads and what it obeys are separate questions with
separate answers.

**A skill declares its ingestion surface.** The surface is every piece of externally-authorable
text the skill reads — issue bodies, comments, PR bodies and their diffs, and any fetched page.
Declaring it is what makes the exposure countable; an undeclared read is one no reviewer can price.

**A skill never treats content as authority.** Ingested text is data about the world, never an
instruction and never a verdict. Authority arrives only through an ACL-checked verb — the ADR
[0055](https://github.com/kamp-us/phoenix/blob/main/.decisions/0055-acl-sourced-review-authz.md)
idiom, where the verb resolves the author against repository permissions and fails closed. A
directive found inside ingested content is content that looks like a directive.

**Coordination is closed-vocabulary.** When a skill signals another lane it emits a kind, an
action, and a branded reference — no free prose. The receiver re-fetches the artifact the reference
names and reads it there, so a coordination message carries nothing that can steer the receiver.

**Terminal states use a terminal vocabulary.** Success without a pull request is a success, and a
back-off is not; a skill that reports both the same way has destroyed the distinction its caller
needs. Each terminal state names itself as one or the other and states the branch disposition —
pushed, left local, or removed.

**A skill declares its capability set.** Shell, tokens, push, merge-queue access: the declaration
is the row the skill will occupy in the threat-model matrix that
[#4860](https://github.com/kamp-us/phoenix/issues/4860) will record. That matrix does not exist
yet, which is exactly why the rows are collected now.

**The open blocker, stated rather than assumed away.** The content-ingestion trust posture is an
open founder decision on [#4859](https://github.com/kamp-us/phoenix/issues/4859) — the trust root,
whether a maintainer-applied label is a required second factor, and what is accepted as out of
model are all unruled. This section fixes the **seam**: where a skill declares what it reads and
where authority is checked. The posture lands in that seam when it is ruled. No skill infers it in
the meantime, and no brief may write down a posture as though it were settled.

> Source: the founder-directed secure-by-default distillation recorded on wayfinder:map
> [#4891](https://github.com/kamp-us/phoenix/issues/4891) (2026-08-08), per-brief acceptance
> criteria 1, 5, 6 and 7. The authority idiom is ADR 0055. Blockers named there and carried here:
> [#4859](https://github.com/kamp-us/phoenix/issues/4859) is open; the
> [#4860](https://github.com/kamp-us/phoenix/issues/4860) threat model is unwritten.

## 10. The leaf rule — a rubric file until a second consumer

**A per-surface leaf is a rubric file by default.** A family entry — `/review`, `/build` — routes
internally, and the per-surface rubrics it routes to are files it reads. Promote a leaf to a real
skill only when two or more skills consume it, or it needs independent invocation. v1's shared
writing rubric is the worked case: both construction and review consume it, so it stays a skill.

The default falls out of what each form costs. A file carries no listing cost and its tokens are
reclaimed when context compacts; a skill re-attaches its content on every invocation. No adherence
difference between the two forms is documented, so there is no measured benefit to buy with that
cost.

**Promotion is not free either.** Folding N surfaces behind one family entry folds N identities into
one, so the family entry's own text has to keep each surface's rules visible — a surface that no
longer has a skill of its own has nowhere else to state them.

> Source: founder ruling on wayfinder:map
> [#4891](https://github.com/kamp-us/phoenix/issues/4891) (2026-08-08, in-session), the leaf rule
> recorded with it.

## 11. GitHub access is REST, never GraphQL

**Every GitHub read and write a fabrika skill or verb makes goes through `gh api` REST, and every
list read paginates.** This section is where that rule lives; a skill contract cites it and does not
restate it.

The forcing reason is the org, not taste: kamp-us runs a legacy Projects-classic integration, and
GraphQL issue and pull-request queries break against it. That rules out the porcelain that silently
takes the GraphQL path — the projects noun, the `pr`/`issue` edit verbs, the explicit GraphQL
transport — in favour of the REST form (`gh api repos/…`, `gh api -X PATCH repos/…`). Pagination is
a **separate** scar riding along: an unpaginated list read returns a plausible first page instead of
an error, so a verb that reads one page and reports a count reports a wrong one with nothing marking
it wrong.

**It is single-sourced here because it is a platform fact with an expiry.** The integration is not
permanent. Stated once, its retirement is one paragraph edited; stated per contract, it is a rule
every copy can drift from while each author assumes some other copy is authoritative.

**Where it is enforced today — stated so nobody assumes coverage it does not have.** The
`skill-gh-lint` job ([`.github/workflows/skill-gh-lint.yml`](../../../.github/workflows/skill-gh-lint.yml),
matchers in [`lint.ts`](../../../packages/pipeline-cli/src/tools/gh-phoenix/lint.ts)) reds on a
GraphQL-path `gh` invocation anywhere in the corpus it walks and fails closed on zero scope
([ADR 0092](../../../.decisions/0092-gates-fail-closed-on-zero-scope.md)). That walk is rooted at
`claude-plugins/kampus-pipeline/`, so **fabrika's own corpus is outside its scope** — here the rule
is prose held by review, not machine-checked. Extending the walk is its own change; this doc does
not assume it.

> Source: the org's Projects-classic constraint, carried through v1 as a per-skill standing
> invariant. Five fabrika contracts each restated it before this section existed
> ([#4929](https://github.com/kamp-us/phoenix/issues/4929)); they now cite it.

## 12. A skill that takes a number declares it

**A skill declares `arguments:` exactly when its own `description` names a number it is invoked
on** — an issue, a pull request, or an epic. That is the whole rule, and it is derivable rather
than curated: read the skill's declared trigger phrases, and if one of them carries a `#N`, the
skill takes a number and declares it. Nothing else qualifies. A skill that reads a number out of
some artifact it fetched has not been *handed* one, and a skill whose subject is a session, a
diff, or a term takes none at all.

Declaring it buys one thing: `/fabrika:review 5492` binds `5492` to a name the body reads,
instead of leaving the model to find the number in the surrounding prose. So the body must
actually read it — **the step that takes the number substitutes `$<name>`, and no second
prose-parsing path for the same number survives the change.** A sentence like "an argument that is
a PR number means repair mode" is exactly that second path, and it goes.

**The declaration is two fields, because one of them cannot carry the hint.** `arguments:` is a
list of *names only* — the loader drops anything that is not a non-numeric string, so a name is
all it can hold. The caller-facing wording lives in `argument-hint:`, and **it must say which kind
of number the skill wants**, because the completion menu is where `/fabrika:review 5492` and
`/fabrika:plan-epic 5492` become distinguishable. Name the argument for its kind too —
`pr_number`, `issue_number`, `epic_number` — since the completion falls back to `[name]` once the
caller starts typing.

**`build` and `build-ui` take two kinds of number in one slot, and the declaration admits both.**
An issue number is construction; a PR number is repair; which one arrives *is* the mode selector,
so neither can be split into its own argument without splitting the skill. Their argument is
`issue_or_pr_number` and their hint spells out both readings plus the third case — omitted, which
sends them to `pick`. Where an argument is optional at all (`build`, `build-ui`, `heal-ci`), the
body says in one line what a blank means, because a blank is what an absent argument substitutes
to and a skill that runs a verb on it has run it on nothing.

> Source: [#5587](https://github.com/kamp-us/phoenix/issues/5587), the M45 native-shell campaign.
> The mechanics are read out of the installed Claude Code build (2.1.233), whose frontmatter
> schema documents `arguments` as "@internal — typed variant of argument-hint; argument-hint is
> the documented form". Both fields are declared here for that reason: the typed one binds the
> name, the documented one is what a caller reads.

## What these conventions deliberately do not cover

- **What a verb owes its caller** — `--help` discoverability, output contracts, usage examples —
  and the shape of a derived contract spec: the CLI interface convention
  ([#4654](https://github.com/kamp-us/phoenix/issues/4654)).
- **The boot document a stateless authoring session works from**: the authoring-brief contract
  ([#4655](https://github.com/kamp-us/phoenix/issues/4655)).

## What fabrika does not take from the reference

The SOTA reference is SOTA on skill-**writing** theory, and that is the whole of what is adopted
above. It carries **no test cases, no regression discipline, no authoring workflow, and no
deterministic tool layer** — its mechanics are embedded shell-and-`gh` prose, which is precisely the
shape the two-layer split (§1) exists to escape.

So the borrowing is one-directional and bounded: **take the vocabulary, the sizing, and the
invocation economics; keep our execution substrate.** Neither source arrives on authority.

> Source: [#4644](https://github.com/kamp-us/phoenix/issues/4644) SKIP list and its calibration
> note (v2's two-layer split is ahead of the reference).
