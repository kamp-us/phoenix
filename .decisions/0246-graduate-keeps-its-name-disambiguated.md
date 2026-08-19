---
id: 0246
title: the ideation skill keeps the name `graduate`; the collision is disambiguated, not renamed
status: accepted
date: 2026-08-09
tags: [fabrika, glossary, vocabulary, pipeline]
---

# 0246 — the ideation skill keeps the name `graduate`; the collision is disambiguated, not renamed

**What this decides:** the fifth fabrika ideation skill is called `graduate`, even though `graduate`
already means something else in this repo — it is a live Tracker verb that *closes* an issue. The
founder chose to keep the name rather than rename the skill, so this entry is the disambiguation:
what each sense means, and how a reader tells which one is on the page.

## Context

The founder ruled the fabrika ideation set on epic
[#5017](https://github.com/kamp-us/phoenix/issues/5017) (2026-08-09,
[comment](https://github.com/kamp-us/phoenix/issues/5017#issuecomment-5229701965)): it is a
**quintet**, not the quartet the epic body assumed — `wayfinding`, `grilling`, `prototyping`,
`graduate`, `handoff` — five independently invocable skills that compose, each landing at
`claude-plugins/fabrika/skills/<name>/` beside the eight siblings ADR
[0242](0242-fabrika-skill-nouns-redefine-build-and-review.md) put in the register. The fifth was
named for its job: it runs on a grilling session or a wayfinding map and synthesizes **one spec
issue** out of the decision trail.

Naming it `graduate` collided immediately. Transcribing the five names into
[`.glossary/TERMS.md`](../.glossary/TERMS.md) surfaced that the word is already spoken for, and the
question went back to the founder as rename-or-keep. He ruled **keep**
([comment](https://github.com/kamp-us/phoenix/issues/5017#issuecomment-5230781267), 2026-08-09) —
verbatim:

> i wanna keep the graduate in the wayfinding and friends

The reason is set-coherence. The quintet is adopted as a *set*, structured on the founder-cited
grounding (Matt Pocock's skills) with one deliberate divergence — `handoff` keeps his meaning
(session-continuity compaction) precisely so nothing graduation-flavoured collides with his
vocabulary. Renaming the fifth member to dodge an internal collision would break the set's reading
as a whole for a word the two senses never actually meet on. So: keep the name, and pay the cost
where it is cheapest — one dated disambiguation entry, which is what this is. Same move ADR 0242
§4 made for `review-ui`.

**What the sweep actually found.** The ruling names one prior sense (the Tracker verb). Reading the
repo first-hand turned up **three** live named surfaces spelling the word, plus an ordinary-English
use — recorded here as found, rather than the one the ruling assumed:

1. **`Tracker.graduate`** — the graduation-close envelope
   ([#3266](https://github.com/kamp-us/phoenix/issues/3266)), implemented in
   `packages/pipeline-cli/src/tools/tracker/tracker.ts`
   and specified by ADR [0190](0190-tracker-design-against-two-build-one.md) as one of the four
   domain-shaped signatures (`claim` / `apply-triage` / `post-verdict` / `graduate`).
2. **`anka-ops flag graduate <key>`** — the Flagship flag-lifecycle verb in
   [`packages/anka-ops/src/flag.ts`](../packages/anka-ops/src/flag.ts): a flag serving fully open in
   prod is eligible to retire, and the command files the retirement chore (ADR
   [0136](0136-flag-retirement-machine-nominates-human-confirms.md)).
3. **fog-graduation** — a wayfinder map's frontier ticket moving into `## Graduated fog`; a
   `TERMS.md` row of its own, and the closest neighbour of all, since the ideation `graduate` skill
   reads exactly those maps.

Plus the plain-English use (an optimistic slice "graduates to served-on"), which names no surface
and needs no ruling.

An unrecorded homonym does not fail loudly. It hands a reader a confident wrong answer — and here
the wrong answer is unusually expensive, because the two most-used senses point in **opposite
directions**: `Tracker.graduate` closes an issue; the ideation `graduate` opens one.

## Decision

**`graduate` is a homonym this repo accepts: the fabrika ideation skill keeps the name, every sense
keeps its own, and which one is meant is read off the namespace the word appears in — never off
context alone.**

### 1. The two senses, stated

**Sense A — `graduate`, the Tracker verb (existing, unchanged).** A verb on the `Tracker` Effect
service over the GitHub-issue layer. It is a **graduation-close**: given a source issue (a map, an
investigation) and a judgment naming the artifact the work graduated into, it records the audit
comment and closes the source with `state_reason=completed` — graduated, not abandoned — returning a
`graduated` verdict carrying the entity's read-back lifecycle state. Its direction is **terminal**:
something finishes.

**Sense B — `graduate`, the fabrika ideation skill (new).** The fifth member of the ideation
quintet, at `claude-plugins/fabrika/skills/graduate/`. It runs on a completed grilling session **or**
a wayfinding map and synthesizes **one spec issue** — problem / solution / decisions / out-of-scope —
linked back to the decision trail as its primary source. It files through the existing report verb
machinery (dedup, footer, provenance), lands `status:needs-triage`, and **writes no board state**:
type, priority, milestone and pickability stay triage's sole authority, and a lane-entering spec's
pitch stamp stays a founder seat (the skill may pre-draft the five fields). Its direction is
**generative**: something is born. Per the ruling, specs are non-persistent — a spec issue closes
once implemented and is never maintained.

They are not two readings of one act. They are near-opposites that happen to share a spelling,
because both describe *leaving a provisional stage carrying what you produced* — one by closing the
old thing, one by emitting a new one.

### 2. How a reader tells which is meant — the namespace, not the vibe

Every named sense is **always** written qualified, and the qualifier is the discriminator:

| written as | sense |
|---|---|
| `Tracker.graduate`, `tracker graduate`, `graduate` in a `Tracker` signature or `pipeline-cli tracker` context | **A** — graduation-close |
| `anka-ops flag graduate <key>` | the flag-lifecycle verb (a third sense, unaffected by this entry) |
| `/graduate`, `claude-plugins/fabrika/skills/graduate/`, `graduate` beside `wayfinding`/`grilling`/`prototyping`/`handoff` | **B** — the ideation skill |
| "graduates onto / off the frontier", `## Graduated fog` | fog-graduation — motion within a map, not a named surface |

**The bare unqualified noun, inside a fabrika or ideation context, means B.** Everywhere else the
qualifier is mandatory: writing bare `graduate` for the Tracker verb outside `Tracker`'s own
signature is the ambiguity this entry exists to prevent, and is banned.

### 3. Keeping the collision is the choice, and it is bounded

Rename was on the table and was rejected. The bound: **this entry claims nothing over any existing
sense.** ADR 0190 keeps `status: accepted` and every word of its decision text; `Tracker.graduate`
is not renamed, not deprecated, and not rescoped. `anka-ops flag graduate` is untouched. The
fog-graduation row is untouched. The only thing that changes is that a **new** surface now also
spells the word, and this file is the dated record of that.

**Binding constraints.**
- Every named use of `graduate` outside its own defining namespace is written qualified.
- The ideation `graduate` never writes board state — no type, priority, milestone or pickability.
- The ideation `graduate` never closes its source; it emits a spec issue at `status:needs-triage`.
- The name is settled by founder ruling: an authoring session may not re-open rename-vs-keep.

**Banned.**
- Bare `graduate` for the Tracker verb outside a `Tracker` signature or context.
- Renaming, deprecating or rescoping any pre-existing sense to make room for the skill.
- Any change under `claude-plugins/kampus-pipeline/` on account of this name (v1 is frozen — ADR
  [0238](0238-fabrika-reimplements-v1-never-calls-it.md)).

## Consequences

- The ideation quintet reads as one coherent set, which is what the founder was protecting.
- A reader who meets `graduate` cold has one place to learn there are several, and one mechanical
  rule — read the namespace — to resolve it without guessing.
- The cost is real and accepted: three named surfaces share a spelling, so a careless bare mention
  is now a genuine ambiguity rather than a typo. The qualification rule above is what keeps that
  cost at authoring time instead of at reading time.
- Nothing pre-existing moves. No ADR is superseded, amended-in-part, or edited by this entry.
- The `graduate` authoring brief is minted under this name, carrying the report-verb-reuse and
  no-board-state rulings as hard constraints.

## Records

- **Vocabulary impact: a term is redefined — `graduate` gains a second named sense.** The word now
  names both the Tracker graduation-close verb and the fabrika ideation skill. The
  [`.glossary/TERMS.md`](../.glossary/TERMS.md) rows carrying **both** senses are consequence (1) of
  the founder's ruling on [#5017](https://github.com/kamp-us/phoenix/issues/5017) and are that
  issue's discharge to write, alongside the other four quintet names — deliberately not this
  additive ADR PR's scope. This entry is the dated disambiguation those rows point at.
- Discharges the ADR half of the ruling recorded at
  [#5017](https://github.com/kamp-us/phoenix/issues/5017) (comments 5229701965, 5229718526,
  5230781267).
