# Fabrika skill-set audits — structural, judgement, and reconstruction-cost, over the 30 v1 skills

*Dated findings — 2026-08-07. Transcribed from [#4890](https://github.com/kamp-us/phoenix/issues/4890)
(milestone "fabrika campaign", execution-core epic [#4650](https://github.com/kamp-us/phoenix/issues/4650)).
This is the evidence base for the design session "what is fabrika's skill set?", charted as
wayfinder:map [#4891](https://github.com/kamp-us/phoenix/issues/4891).*

**The headline caveat — read it before any number below. Shared structure is not sameness.**
The structural lens, run alone, recommended **merging `canon` + `glossary`** on a *reported*
~75% structural overlap. The founder **overruled** it: a pattern doc records best practice for a
technology, a glossary defines terms — different judgement, therefore different skills. That
overrule is the reason lenses 2 and 3 exist, and it is why the granularity rule came out as
"split by judgement" rather than "split by shape". A reading of this report that drops the
caveat inverts its central finding.

**The overlap figure, the merge recommendation, and the overrule are all *reported, not
verified*** — see [Reported, not verified](#reported-not-verified) for exactly what the repo
does and does not corroborate.

## How to read this document

Every figure here is marked one of two ways, and the marks are the point:

- **Verified against source** — re-run against the checked-out tree during triage on 2026-08-08.
  Reproducible: the file is named, the count is countable.
- **Reported, not verified** — relayed from the audit runs of 2026-08-07. The audits themselves
  are not in the tree, and no methodology for a "% judgement" measure exists in the repo, so
  these numbers are **not** reproducible from source. They are the auditors' read, carried here
  as their read.

No relayed measurement in this file is presented as a repo-grounded fact. If a percentage
appears without its qualifier anywhere below, that is a transcription defect, not a promotion.

**Scope, ruled by the founder on 2026-08-07: these findings apply to fabrika only. v1 is not
updated.**

## The three lenses

| lens | question | what it produces |
|---|---|---|
| structural | what does a skill CONTAIN | responsibilities, seams, deep-vs-shallow |
| judgement | what does it DECIDE | judgement kinds — what makes a skill a skill |
| reconstruction | what does a HANDOFF cost | which seams are cheap, which are ruinous |

The structural lens alone is blind: it produced the merge recommendation the founder overruled
(see the headline caveat). Lenses 2 and 3 were added in response.

## The five rules

1. **Verb vs skill.** Already written down in `claude-plugins/fabrika/skills/triage/contract.md`,
   where **"Split test" is a literal column header** *(verified against source)*: work whose
   answer is **checkable by construction** → a verb; **a judgement someone could get confidently
   wrong** → a skill.
2. **Skill vs skill — split by mode, never by topic.** From
   `claude-plugins/kampus-pipeline/skills/taste-library-conventions.md` *(verified against
   source)*. "Mode" means the **judgement**, not the procedure shape. A shared skeleton is
   machinery to factor out, never a reason to merge.
3. **Judgement stays with the model.** 0% judgement is not a goal — it only identifies things
   that were never skills. Do not manufacture mechanism by deleting a call an LLM should make.
4. **Context vs evidence.** A sender's trail across a session boundary is *context, not
   evidence*. A seam is cheap when only context must cross, expensive when evidence must be
   re-derived — and at a review gate that expense **is** the product.
5. **Skill boundary is not session boundary.** Founder-ruled: hard boundaries between skills are
   fine, because skills compose inside one agent session/role. Split skills freely by judgement;
   design roles separately.

## Measured findings

Figures marked *verified* were re-counted against the tree on 2026-08-08. Figures marked
*reported* come from the 2026-08-07 audits and were **not** reproducible from the repo. Several
line counts have since drifted — see [Provenance and drift](#provenance-and-drift).

| skill | measure | mark | implication |
|---|---|---|---|
| `ship-it` | 2061 lines | verified | a thin skill over rich verbs |
| `ship-it` | ~5% judgement; ONE live decision (bot thread nit-vs-substantive) | **reported, not verified** | its length is accumulated incident provenance, not decisions |
| `write-code` | 1867 lines | verified | — |
| `write-code` | 14 responsibilities; holds **3 of 5** execution judgement kinds, in two pockets (construction/craft; scope honesty) | **reported, not verified** | the real judgement holder in the system |
| `review-doc` / `review-skill` / `review-design` | **76% / 80% / 58%** shared skeleton | **reported, not verified** | six review gates read as one harness plus six rubrics |
| `resolve-repo.sh` | **16 copies**, one under each of 16 `claude-plugins/kampus-pipeline/skills/*/scripts/` directories, all 16 differing from one another by an owner-naming comment | verified | the shared-doc extraction was started and never finished |
| `triage` v1 → fabrika | **858 → 160 lines** (−81%), plus a **1705-line** contract | verified | the only completed instance of this refactor; the rule describes what actually happened |
| `report` v1 → fabrika | **177 → 113 lines** | verified | the cut scales with mechanical mass, not importance |
| `doctor` | **0% judgement**, per two independent audits | **reported, not verified** | a verb, not a skill |
| `doctor` | its own body says relay the output "verbatim … then stop" (`claude-plugins/kampus-pipeline/skills/doctor/SKILL.md`) | verified | corroborates the reported 0% |
| `review-trivial` | ~85% mechanism; no namespace of its own; dormant; designed to refuse judgement | **reported, not verified** | read as a mode of the code gate, not a sibling skill |
| `review-plan` | verdict is **100% deterministic**; its judgement is advisory and structurally cannot block | **reported, not verified** | open whether it is a skill at all |
| `canon` / `glossary` | ~75% structural overlap | **reported, not verified** (see below) | stay separate — founder-ruled; factor the skeleton |
| `author-skill`, `writing-clearly-and-concisely`, `taste-animation-vocabulary` | INFORM rather than DECIDE | **reported, not verified** | reference documents other skills read, not skills |
| `taste-animation-*` | four siblings → **three procedures + one reference** | **reported, not verified** | the judgement rule cuts a family a size audit cannot |

Two further source-grounded quotes the audits leaned on, both *verified against source*:

- `ship-it` describes judgement it **deleted**: the control-plane discharge is "a function of …
  team shape, never agent judgment" (`claude-plugins/kampus-pipeline/skills/ship-it/SKILL.md`).
- A `ship-it` resolve is "the **only** mechanism in the pipeline that can clear a thread" (same
  file) — the fact that makes the ship → repair reroute a deadlock, below.

### Corrections applied to the original audit numbers

Three figures in the original filing were wrong and are corrected here. Each correction is
*verified against source*:

1. **`resolve-repo.sh` is duplicated 16 times, not four.** The original said "four copies
   differing by one comment line". There are **16**, one per `claude-plugins/kampus-pipeline/skills/*/scripts/`
   directory, and all 16 differ from one another (each carries an owner-naming comment). The
   `canon`/`glossary` pair differs by that comment plus one extra sentence on canon's copy. The
   finding's shape holds and was **understated roughly fourfold** — which strengthens "the
   shared-doc extraction was started and never finished".
2. **The fabrika triage contract is 1705 lines, not 1695.**
3. **"context, not evidence" is a script comment, not skill prose.** The original attributed it
   to `review-code`'s SKILL.md. It lives at
   `claude-plugins/kampus-pipeline/skills/review-code/scripts/issue-context.sh`. The rule is
   real; it is cited at its actual site in rule 4 above.

<a id="reported-not-verified"></a>
### Reported, not verified — the full list, and what the repo *does* corroborate

- **Every judgement percentage** — `ship-it` ~5%, `write-code` 14%, `doctor` 0%,
  `review-trivial` ~85%, `review-plan` 100% deterministic, and the 76/80/58% review-skeleton
  figures. No methodology for "% judgement" exists in the repo, so none of these is reproducible
  from source.
- **The ~75% `canon`/`glossary` structural overlap, the merge recommendation, and the founder's
  overrule.** What the repo *does* confirm: `canon/SKILL.md` (277 lines) and `glossary/SKILL.md`
  (204 lines) share a section skeleton — **7 of glossary's 9 top-level headings have a canon
  counterpart** (Scope / Repo-agnostic / The extracted scripts / Mode selection / Bootstrap mode
  / Incremental mode / Conventions). That is a real shared skeleton, and it is directionally
  consistent with a high overlap figure. The specific **~75%**, the **merge recommendation**,
  and the **overrule** were **not** verified — and the overrule has no record on either brief
  (see [Ruling-recording status](#ruling-recording-status)).
- **The judgement-cluster counts and the seam-cost narrative** below. Analysis, not measurement;
  carry them as the auditors' read.

## Judgement clusters — reported, not verified

The counts in this section are the auditors' clustering, not a repo measurement.

- **Review family — 5 kinds across 6 skills, misaligned.** Two kinds are split across owners:
  **governance-corpus integrity** (the ADR contradiction sweep in `review-doc` plus
  gate-invariant preservation in `review-skill`) — named the highest-consequence judgement in
  the set, currently with **no single owner** — and **editorial craft** (`review-doc` +
  `review-code`).
- **Execution — 5 kinds.** `write-code` holds 3, `ship-it` holds half of one, `heal-ci` holds 1.
- **Knowledge — 4 kinds across 5 skills.**
- **Craft — 4 kinds plus 3 non-deciders across 8 skills.**
- **Ops — 3 kinds across 5 skills.**

## Seam costs — reported, not verified

Narrative analysis from the reconstruction-cost lens. The quoted skill text inside it is
*verified against source* where noted above.

- **build → review.** The expensive re-derivation — re-read the diff, re-grade every criterion,
  re-understand the subsystem, re-run the tests — is **deliberate independence**. The gate is
  worthless without it. The waste is all cheap re-parsing: re-resolving the issue link,
  re-classifying control-plane, re-reading a marker.
- **review → ship.** The unresolved-thread judgement is made **twice**, and `ship-it` makes it on
  **thinner** context — it holds changed file *paths*, never the hunks.
- **ship → repair.** Routing the nit judgement out of `ship-it` **deadlocks**. Repair cannot
  resolve threads (GraphQL is barred there), `review-code` explicitly does not resolve them, and
  `ship-it` states its resolve is the only mechanism that can clear a thread and let a PR enqueue
  at all *(that last clause is verified against source)*.
- **intake chain.** Three things never serialize: **severity** (`report` is forbidden to encode
  it, so it is destroyed at the first handoff by design), **split rationale** (`plan-epic` writes
  it, then children are required to be self-contained and may name no file paths), and
  **cross-slice consequence** (the only channel is a free-prose field with no schema, no gate, no
  parser).
- **skill → verb: cheap** — and this asymmetry explains the rest: **a verb needs the conclusion;
  an agent needs the reasoning.** Conclusions serialize; reasoning does not.
- **`build | publish`: free as a skill split, ruinous as a session boundary.** The least
  serializable cut measured. A deviation is by definition the thing nobody wrote down yet, and
  the closing-keyword call is a judgement over intent, not over the diff. Recorded failures where
  this went wrong: [#2414](https://github.com/kamp-us/phoenix/issues/2414),
  [#2420](https://github.com/kamp-us/phoenix/issues/2420).

**The test for any proposed cut:** a cut is cheap if and only if everything the second half needs
already has a durable home it would be written to anyway, and the first half made no judgement
the second half cannot re-derive from that home.

## Decided — founder, 2026-08-07. Do not re-litigate.

- Findings apply to **fabrika only**; v1 is not updated.
- **[#4722](https://github.com/kamp-us/phoenix/issues/4722) `/doctor` — killed.**
- **[#4715](https://github.com/kamp-us/phoenix/issues/4715) `/review-trivial` — killed.**
- **[#4710](https://github.com/kamp-us/phoenix/issues/4710) (pattern-doc) and
  [#4711](https://github.com/kamp-us/phoenix/issues/4711) (`/glossary`) stay separate.**
- **`ship-it` keeps its one judgement** in the skill
  ([#4709](https://github.com/kamp-us/phoenix/issues/4709)); the proposal to route it to repair
  was rejected, and is additionally a deadlock.
- Hard skill boundaries are fine, because skills compose inside one agent session.

<a id="ruling-recording-status"></a>
### Ruling-recording status — checked via REST on 2026-08-08

This table exists so the gap is visible rather than assumed closed. Three of the five rulings
this document is the evidence base for were **unrecorded on their own tickets** when it was
written.

| ticket | ruling | recorded, as of 2026-08-08? |
|---|---|---|
| [#4722](https://github.com/kamp-us/phoenix/issues/4722) `/doctor` | killed | **yes** — closed `not_planned`, `closed-by-triage` |
| [#4715](https://github.com/kamp-us/phoenix/issues/4715) `/review-trivial` | killed | **yes** — closed `not_planned`, `closed-by-triage` |
| [#4709](https://github.com/kamp-us/phoenix/issues/4709) `/ship-it` | amendment — keeps its one judgement | **no** — open; only comment was a 2026-08-01 gate amendment |
| [#4710](https://github.com/kamp-us/phoenix/issues/4710) pattern-doc | stay separate | **no** — open, zero comments |
| [#4711](https://github.com/kamp-us/phoenix/issues/4711) `/glossary` | stay separate | **no** — open, zero comments |

Landing those three rulings is the founder's confirmation to give; it was explicitly out of
scope for this transcription.

## Open — the design session's agenda. Carried as open; nothing here is answered.

1. **Who owns governance-corpus integrity?** One judgement kind, two owners, no home, and it is
   the highest-consequence judgement in the set. *Settled by:* a decision naming a single owning
   skill (existing or new) for the ADR contradiction sweep plus gate-invariant preservation, and
   an ADR recording it.
2. **Is "construction/craft" one judgement or three** — code, visual composition, prose mode?
   *Settled by:* a decision on whether `write-code` is one skill or three, which requires
   distinguishing the three candidate judgements sharply enough that a cut between them is
   checkable.
3. **What is fabrika's skill set** — which of the 16 authoring briefs
   ([#4707–#4721](https://github.com/kamp-us/phoenix/issues/4707)) live, die, merge, or split?
   This is the session's actual subject. *Settled by:* a per-brief live/die/merge/split verdict
   across all 16, applied against the five rules above.
4. **ADR 0052 is `proposed`, not accepted** *(verified against source — `status: proposed` in its
   frontmatter)*, yet `review-skill`'s config-pin — the guard against a skill PR weakening its own
   gate — rests on it. A live invariant standing on an unratified decision. *Settled by:* either
   ratifying 0052, or re-basing the config-pin on an accepted decision.

> A **fifth** question was appended to [#4890](https://github.com/kamp-us/phoenix/issues/4890) by
> amendment on 2026-08-08 — whether fabrika's `triage enrich` should keep v1's two-detector
> asymmetry (default keys on terminality, `--epic` keys on its own headers). It is tracked
> separately, and [#4892](https://github.com/kamp-us/phoenix/issues/4892) is its concrete
> instance. It is noted here for completeness; the four questions above are the agenda this
> document was assembled to ground.

## Method caveat

A judgement auditor was handed `canon` + `glossary` **blind** to the founder's ruling, as a
calibration test. It clustered them together, but independently named the exact seam the founder
named, and called it "the only genuine collapse candidate, and it's partial."

**The method surfaces a fork; it does not decide one.** Treat its output as evidence for a human
call, never as a verdict. This is the same lesson as the headline caveat, arrived at from the
other side.

## Provenance and drift

- **Source.** The audit findings, the corrections, the verified/reported split, and the rulings
  above are transcribed from [#4890](https://github.com/kamp-us/phoenix/issues/4890) and its
  triage comments. The three audit runs themselves are not in the tree, which is why the
  judgement figures cannot be re-derived here.
- **Line counts drift; the snapshot does not.** The verified counts above were taken on
  2026-08-08. Re-counted on 2026-08-09 the same files read: `ship-it` 2077, `write-code` 1867,
  `triage` v1 874, fabrika `triage` 164, the fabrika triage contract 1816, `report` 177 → 113,
  `canon` 277, `glossary` 204, `resolve-repo.sh` still 16 copies. The corpus is under active
  change, so treat every count here as of its stated date — the ratios and the shape are what the
  findings rest on, not the exact integers.
- **Ruling-recording drift.** Re-checked on 2026-08-09: #4709 is now closed `completed`, and
  #4710 and #4711 are open with comments where the 2026-08-08 table found none. The table above
  is preserved as of its stated date; check the tickets for their current state.
