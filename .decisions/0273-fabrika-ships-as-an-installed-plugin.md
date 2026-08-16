---
id: 0273
title: fabrika ships as an installed plugin from day one — external consumability gates release
status: accepted
date: 2026-08-10
tags: [fabrika, plugin-portability, packaging, distribution, pipeline]
---

# 0273 — fabrika ships as an installed plugin from day one — external consumability gates release

**What this decides:** fabrika is used the same way an outside repo uses it — installed as a plugin — starting now, not after v1 lands. The channel we ship down is the channel we use ourselves. A fabrika skill may only need things it can find by opening the repo it is installed into; needing anything else is a defect that blocks release, not a hardening task for later.

## Context

This records a founder ruling whose durable home has been
[#4776](https://github.com/kamp-us/phoenix/issues/4776) since 2026-08-02. That issue's own body
states it is the home *"until an ADR exists"* and its triage note records the ADR as warranted and
conversation-authored rather than ticketed. This file discharges that stated intent; it invents no
scope.

### What went wrong in v1, recorded

The v1 pipeline plugin was authored inside the repo that vendors it, and phoenix's own copy of the
plugin tree meant the install path was never exercised the way a consumer exercises it. The cost is
recorded, first-hand, in three places.

- **The consumer path was broken and no in-repo check could see it**
  ([#4775](https://github.com/kamp-us/phoenix/issues/4775), 2026-08-02). A real session run inside a
  clone of a consuming repo found `CLAUDE_PLUGIN_ROOT` unset, `.claude/.pipeline` never planted, and
  the consuming repo carrying no `claude-plugins/` directory — so **both** skill-fence forms in the
  corpus resolved to nothing and exited 127. Triage's own finding names the asymmetry that hid it:
  phoenix's working link is planted by phoenix's **own committed** `.claude/settings.json` through a
  vendored in-repo hook path, entirely independent of whether the plugin loads at all. The link's
  presence at home was therefore never evidence the remedy reached anyone else. The same run recorded
  a marketplace install that reported success against an install path that did not exist — an
  observation whose mechanism was explicitly **not** diagnosed.
- **The guard that existed was blind to the defect it was for.** The fence-portability check matched
  only paths beginning `./claude-plugins/…`, so **151 occurrences across 33 files** — the
  `${CLAUDE_PLUGIN_ROOT:-…}` and planted-link shapes — were invisible to it, and it passed on a
  corpus that was roughly 40% unconverted.
- **The same absence bit at home too**
  ([#4666](https://github.com/kamp-us/phoenix/issues/4666), 2026-08-01). In freshly provisioned
  isolated worktrees the planted link was absent, so every fence exited 127 at once with empty
  stdout — the could-not-run signal that reads like an ordinary "no". Two independent lanes hit it
  and improvised two different recoveries.
- **The gate could not be answered.** The external-consumer confirmation gate on
  [#4670](https://github.com/kamp-us/phoenix/issues/4670) sat open and, in #4776's words,
  *"unanswerable for two days"* because its evidence was believed unobservable — while
  [PR #4771](https://github.com/kamp-us/phoenix/pull/4771), which re-touches the same install
  surface, was banked behind it.

That is the shape of the failure: a delivery path nobody ran, a guard that could not see it, and a
release gate with no way to answer itself.

The disease reappeared inside fabrika, which is why day-one is the ruling and not a preference. A
founder-ordered read-only portability audit of all 15 landed fabrika skills (2026-08-10, recorded on
[#5247](https://github.com/kamp-us/phoenix/issues/5247)) found 3 skills with no required-repo-files
declaration, a landed skill contract referencing infrastructure no repo contains, 6 command examples
hardcoding this repo, and — [#5254](https://github.com/kamp-us/phoenix/issues/5254) — an `adr` verb
that refused a readable-but-empty `.decisions/` as a failed read, making a fresh adopter's ADR 0001
structurally unmintable.

### How this differs from the ADRs next to it

- ADR [0062](0062-repo-as-config-plugin.md) decides **which repo** a skill operates on: the target
  resolves from `CLAUDE_PIPELINE_REPO`, else the working git repo. That is parameterization of a
  skill's *target*. This ADR is about the skill's *inputs* and about *when* the install path is
  exercised — 0062 §5 explicitly recommends phoenix maintainers do **not** install the plugin into
  phoenix itself and rely on local discovery instead. For fabrika that recommendation is inverted:
  installing is the point.
- ADR [0110](0110-plugin-carries-no-version-continuous-ship.md) decides that the plugin carries no
  `version`, so every commit on the tracked ref is the release. It settles the *cadence* of shipping
  and closes with the caveat that continuous-ship is "not a model to copy blindly for a plugin with
  external consumers". This ADR settles the *criterion*: it does not touch cadence, it says the
  artifact must work outside its home repo before it counts as shipped.
- ADR [0171](0171-kampus-pipeline-plugin-spec-conformance.md) audits the v1 plugin's **manifest and
  layout** against the official plugin spec and records each deviation as documented-intentional.
  Spec conformance is a static property of the packaging; this ADR is about a runtime property of the
  installed thing — a plugin can be perfectly spec-conformant and still exit 127 in every consumer,
  which is exactly what #4775 observed.
- ADR [0238](0238-fabrika-reimplements-v1-never-calls-it.md) bans fabrika from invoking v1, so v1
  stays deletable. That is a *dependency-direction* rule inside this repo. This ADR is the wider
  test: not-v1 is necessary but not sufficient, because a skill can avoid v1 entirely and still
  depend on a hosted service, an ops CLI, or a file only phoenix has. 0238 stands unchanged and this
  decision sits on top of it.
- ADR [0086](0086-ship-it-foreign-repo-degradation.md) is the closest prior art and it is a
  *remediation*: a v1 skill whose gate depended on a CI producer the plugin does not distribute was
  taught to degrade on producer-presence, after the dependency had already shipped. This ADR moves
  that judgment to authoring time — the dependency does not land and then get degraded; it does not
  land.

Two more the sweep raised, resolved here rather than left adjacent. ADR
[0255](0255-skill-namespaces-keep-v1-and-fabrika-apart.md) measures that a fabrika skill is loaded
**from the plugin** and reached as `fabrika:<name>`, while v1 loads project-level through the
`.claude/skills` symlink — that is the mechanism this decision rides on, and it stands untouched;
0255 settles *how the two rosters coexist*, this settles *what an installed fabrika skill is allowed
to need*. ADR [0221](0221-pipeline-anywhere-ga-two-tiers.md) declares GA for the **v1** pipeline as
four staged gates ending in a post-GA fresh-bootstrap proof. That is a different artifact on a
different clock, and the contrast is deliberate: v1 earned its outside-consumer proof in stages after
the fact, and #4775 is what that cost. fabrika does not get the staged version. Neither ADR is
amended.

No live `accepted` ADR rules the other way on this question. ADR
[0245](0245-campaign-scope-fence-binds-both-seams.md) rules on **campaign admission**, a different
question, and this decision does not disturb it.

## Decision

**fabrika v1 is consumed as an installed plugin from day one, so it is exercised exactly the way an
external consumer exercises it — the ship channel is the dogfood channel — and external consumability
is a shipping criterion, not later hardening.**

The operative test, in the founder's framing (recorded 2026-08-10): **a fabrika skill may depend only
on things that live in the repo it runs in.** Files, docs, conventions, committed manifests — anything
obtainable by opening the repository the skill is installed into. This supersedes "nothing
phoenix-specific" as the wording of the test, because "specific" invites argument while
repo-resident-or-not has one answer, checkable by reading the skill's inputs.

The rule cuts both ways, and that is the point. A skill **may** require things: a `.decisions/`
directory, a conventions doc, a committed manifest, a label taxonomy. What it may not do is require
something that is not in a repo at all.

The scope clause travels with it, quoted from #4776: *"Anything bearing on how fabrika ships is in
scope for milestone 44 (fabrika campaign), regardless of its current axis label. The delivery path is
part of the campaign, not adjacent to it."*

**Binding constraints.**
- Every input a fabrika skill, contract, or verb requires is obtainable by opening the repository it
  is installed into.
- Each skill declares that input set in its `## Required repo files` section, in the three-column
  shape the front-door contract parses, with each row's disposition drawn from the closed set
  **`fail-loud` · `degrade` · `bootstrap`**.
- A declared disposition states what the skill **already does**. A row that contradicts the code is
  worse than no row.
- A `fail-loud` row names the absent surface and points at the front door; it never dead-ends in a
  bare error.
- An authoring brief whose v1 prior art rests on non-repo-resident infrastructure derives a portable
  equivalent or stops. It never ports the specifics through.

**Banned.**
- A dependency on infrastructure no repo contains — a hosted control plane, an ops CLI, a
  feature-flag or deployment platform, an account-scoped service, a dashboard.
- A dependency on a file, tree, or environment variable that exists only because *this* repo vendors
  the plugin (the vendored `claude-plugins/` tree, a hook-planted link this repo's own settings
  plant, an env var only the vendoring harness exports).
- A repo literal inside a runnable fence or a command example.
- Shipping a fabrika skill that has never been exercised through the installed-plugin path.
- Deferring any of the above to post-release hardening.

Releasing a product to users is a **product** concern, not a fabrika concern — fabrika is the factory
for authoring, reviewing, deciding, recording and shipping *code*. That boundary is independent of the
portability test and is recorded here because the two together are what cut the `/release` skill from
fabrika's scope.

## Consequences

**What a violation is, checkably.** A fabrika skill is in breach when any one of these holds, and each
is answerable by reading the skill and the repo — no judgement call about what counts as "specific":

1. An input it requires cannot be satisfied by a repo that is not this one, opening only itself.
2. It has no `## Required repo files` section. Undeclared is not satisfied — the front-door reader
   emits a single `undeclared` row with presence `unknown`, never zero rows and never counted clean.
3. A declared row's disposition is not one of `fail-loud` / `degrade` / `bootstrap`, or contradicts
   what the code does on the missing-surface path.
4. A runnable fence or a command example names a specific repository.
5. It resolves a path through an artifact only the vendoring repo produces.

**What a reviewer looks for**, concretely, in this order: enumerate the skill's inputs from its
`SKILL.md` and its contract; for each, ask whether a repo that is not this one could obtain it by
opening itself; check that the `## Required repo files` table lists exactly that set with a
closed-set disposition per row; walk each `fail-loud` path and confirm it names the missing surface
rather than erroring bare; grep the runnable fences and examples for a repository literal. The
enumeration is the review — a portability claim with no input list behind it is not one.

**The mechanical property that falls out**, stated plainly so a future guard has something to enforce
and deliberately not designed here: *for every landed fabrika skill, the set of inputs it requires is
declared, and every declared input is a path inside the repository the skill runs in.* Both halves
are enumerable from the corpus and diffable across commits. Specifying a check for it is separate
work and is not decided by this ADR.

**Costs, honestly.** Dogfooding through the install path is slower than reading skills out of the
working tree — a change is not live until it lands on the tracked ref and the install updates. That
is the price of the channel being the same one consumers get, and it is the property #4775 shows we
were buying nothing by avoiding. Some capability is simply out of scope now: a skill needing a flag
service, an ops CLI, or a deployment platform cannot be a fabrika skill, and cutting it is the
correct outcome rather than a gap to close later.

**In exchange**, the release gate becomes answerable. "Does it work for a consumer" stops being an
unobservable question about a gitignored per-clone artifact and becomes an enumeration a reviewer can
run at authoring time — which is the whole difference between #4775 (two days unanswerable) and the
2026-08-10 audit (15 skills, 5 findings, one afternoon).

## Records

Discharges the ADR that [#4776](https://github.com/kamp-us/phoenix/issues/4776) names as owed; that
issue's remaining doc-and-board propagation is unaffected and stays open on its own criteria.
Conversation-authored under ADR [0075](0075-issueless-doc-pr-merge-seam.md). Related recorded rulings:
[#5049](https://github.com/kamp-us/phoenix/issues/5049) (the required-repo-files manifest mandate) and
[#5247](https://github.com/kamp-us/phoenix/issues/5247) (the portability ruling and its sharpened test).

## Amendment (2026-08-16) — the plugin's own dev repo consumes from the checkout

Founder ruling, recorded on [#5705](https://github.com/kamp-us/phoenix/issues/5705). The staleness
cost this ADR priced in ("a change is not live until it lands on the tracked ref and the install
updates") proved worse than priced: on 2026-08-16 alone, three just-merged plugin changes were
invisible to running sessions until a manual `/plugin` update plus `/reload-plugins`, and the first
reload without the update silently changed nothing because the cache was pinned to a pre-merge
commit. The failure mode is silent (agent-not-found, stale skill text) in the one repo where fabrika
changes many times a day.

**Amended decision:** phoenix — the repo that authors the plugin — registers the `kampus`
marketplace as a directory source pointing at its own checkout (`claude plugin marketplace add ./`,
once per machine), so plugin content resolves from the working tree. External consumers are
unchanged: they install from the GitHub marketplace exactly as this ADR rules, and that channel
remains the release criterion.

What this does and does not weaken. The portability test (**repo-resident** inputs), the
`## Required repo files` mandate, the banned list, and the review-time enumeration all stand
untouched — they are properties of the skill corpus, not of which machine consumes it from where.
What is given up is phoenix's own sessions exercising the GitHub install path day to day; that proof
now comes from external consumers and from review-time enumeration rather than from dogfood. The
founder ruled that trade explicitly (2026-08-16): the dev repo's iteration loop wins.

The repo's `.claude/settings.json` previously carried an `extraKnownMarketplaces` block intended to
auto-register the GitHub marketplace for cloners; Claude Code 2.1.233 never registers project-scope
`extraKnownMarketplaces` (verified live, recorded on #5705), so the block was inert and is removed.
A fresh clone runs the one-liner above; when Claude Code fixes project-scope registration, a
directory-source settings block can restore zero-step clones.

Vocabulary impact: this ADR adopts **repo-resident** as the operative portability test — an input a
skill can obtain by opening the repository it is installed into, and nothing else. It is not
"non-phoenix-specific" (the phrasing it replaces), not repo-*agnostic* targeting (ADR
[0062](0062-repo-as-config-plugin.md), which is about *which* repo a skill acts on), and not spec
conformance (ADR [0171](0171-kampus-pipeline-plugin-spec-conformance.md)). It needs that "not …"
disambiguation, so it is routed to [`.glossary/TERMS.md`](../.glossary/TERMS.md) through the glossary
skill rather than added inline here.
