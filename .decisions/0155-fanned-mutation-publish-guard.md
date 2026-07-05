---
id: 0155
title: "A CI guard makes omitting the /fate/live publish loud — every mutation is classified fanned/not in a manifest, and a fanned mutation that omits the publish fails the build (chosen over a required-publish wrapper and a type-level seam)"
status: accepted
date: 2026-07-05
tags: [fate, fate-live, ci, gates, pipeline, control-plane]
---

# 0155 — The fanned-mutation publish guard: classify every mutation, fail the build on a fanned mutation that omits the /fate/live publish

> **ADR-number bump.** Issue #1898 named this ADR **0140** ("last taken is 0139 — claim
> 0140"). By the time this landed, a concurrent authoring wave had taken **0140 through
> 0154**, so this ADR claims the next free number by a live `ls .decisions/` scan, **0155**,
> per the issue's own bump instruction ("if a concurrent author has taken it, take the next
> free number and note the bump").

## Context

phoenix runs one `/fate/live` SSE fan-out (ADRs [0023](0023-live-views-sse-livedo.md) /
[0037](0037-unified-void-aligned-live-do.md)): a mutation that writes an entity living in a
subscribed connection (a **fanned entity** — `Post`, `Comment`, `Definition`, the entities in
the `posts` / `Post.comments` / `Term.definitions` topics) must, after the DB write, publish
the corresponding invalidation through the per-request `WorkerLivePublisher`
(`.patterns/fate-live-views.md` §Server). Omit that publish and the mutation is **silently
half-broken**: it commits correctly, returns a correct ack, and passes every type check and
test — but every *other* client's open live view goes stale until a manual refresh. The
failure is invisible at the mutation site by construction, which is exactly why Phase 2 of
epic #1892 had to retrofit the missing publish into four already-merged features
(#1893–#1896): divan, bildirim, report, pasaport each shipped a fanned mutation with no
`/fate/live` publish, and nothing caught it.

The publisher's error channel is `never` by contract (`fate-live/live-publisher.ts`; ADR
0039): a publish **cannot** fail the committed mutation, it is fired-and-forgotten on
`waitUntil` and any delivery failure is swallowed-with-log. That fail-safe property is what
makes the omission so quiet — the compiler never forces you to handle a publish, because there
is no failure to handle. The seam that already exists — `WorkerLivePublisher` in
`fate-live/protocol.ts` — is only a **typo gate**: it narrows `topic`'s procedure to the
closed `LiveTopicKey` union so a *misspelled* topic is a compile error. It does nothing about
a mutation that never reaches for the publisher at all.

So the omission is **hard to do loudly**. This ADR records the mechanism that makes it hard to
do *silently*, and weighs the three alternatives #1898 named.

## The three alternatives weighed

### (a) A required-publish wrapper at the `Fate.mutation` / `WorkerLivePublisher` boundary

Make-invalid-states-unrepresentable: have `Fate.mutation` (or a phoenix wrapper over it) take
the publish as a **required argument** for a mutation over a fanned entity, so a fanned
mutation that omits it doesn't construct.

**Rejected — fannedness is not knowable at the `Fate.mutation` signature.** Whether a mutation
writes a fanned entity is a property of *which service method its resolver body calls* at
runtime (`Pano.moderateRemovePost`, `Sozluk.moderateRemoveDefinition`, …), not of the
mutation's input/output/error schemas that `Fate.mutation` sees. A wrapper that required a
publish argument would have to require it of **every** mutation — including the many that
legitimately fan nothing (`bildirim.markRead` writes a per-user notification row in no
subscribed connection; `divan.vote` scores a *sandboxed* item that is deliberately absent from
the public feed; `user.setUsername` mutates identity with no fanned entity). Forcing a
`publish: …` argument onto those either invites a meaningless `() => Effect.void` (the
omission, one indirection deeper — no safer) or over-constrains correct code. The wrapper
cannot distinguish fanned from not-fanned, so it cannot make *only the fanned* omission
unrepresentable.

### (c) A type-level seam

Encode fannedness in the type system so a fanned mutation that omits the publish is a compile
error.

**Rejected — same root cause as (a), one level up.** TypeScript cannot see which D1 table or
which content-service method a resolver body ends up writing; that is value-level control flow
inside an `Effect.fn`, not a type. To make the type carry fannedness you would have to *hand-
annotate* each mutation as fanned (a phantom type parameter, a branded return) — at which point
the annotation itself is the thing that can be forgotten, and the type only enforces
consistency *given* a correct annotation. That is a strictly weaker version of option (b)'s
manifest with a heavier, more invasive type surface and no better guarantee against the actual
failure (a *new* fanned mutation nobody annotated).

### (b) A CI guard (the `epic-ledger`-idiom Effect CLI check) — **chosen**

Per CLAUDE.md's Node-over-Python rule, add an `effect/unstable/cli` guard to `pipeline-cli`
that inspects mutation source and fails the build when a fanned mutation omits the publish. The
guard makes fannedness an **explicit, declared** fact instead of an inferred one, and turns
"forgot to publish" into a red CI job.

**Chosen because it targets the failure where it actually lives.** The two properties (a)/(c)
lack — knowing *which* mutations are fanned, and forcing a decision on a *new* one — are
exactly what a declared manifest + a drift check give:

1. **A manifest classifies every mutation.**
   `apps/web/worker/features/fate-live/fanned-mutations.ts` lists every `entity.verb` mutation
   key with `fanned: true | false` and a one-line rationale. The classification is a conscious,
   reviewable product decision recorded next to the live substrate, not a guess the tooling
   makes.

2. **A drift check forces the decision on every new mutation (the loud-at-authoring half).**
   The guard discovers every `Fate.mutation("<key>", …)` across
   `apps/web/worker/features/*/mutations.ts` and asserts the discovered set **equals** the
   manifest's key set. Add a mutation without classifying it → the guard fails with
   `unclassified mutation`. You cannot merge a new mutation without deciding, on the record,
   whether it fans — which is the moment the omission would otherwise be made silently.

3. **A publish check forces the publish on every fanned mutation (the loud-at-CI half).**
   For each `fanned: true` mutation, the guard asserts its feature's `mutations.ts` references
   a `WorkerLivePublisher` publish. A fanned mutation whose feature never reaches the publisher
   fails with `fanned mutation omits the /fate/live publish`.

4. **Fail-closed on zero scope (ADR [0092](0092-gates-fail-closed-on-zero-scope.md)).**
   If the discovery scan finds zero mutations, that is a misconfiguration (wrong root, a
   features-dir reshape), not a vacuous green — the guard fails. This is the non-empty-scope
   check #1898 requires of a CI guard, mirroring `readme-guard`.

The guard is a **pure core + thin IO seam + CLI command** in the exact `readme-guard` shape
(`fanout-guard.ts` decides over gathered facts, `gate.ts` crosses the filesystem, `command.ts`
wires the `effect/unstable/cli` `Command`), wired into CI fail-closed by a `fanout-guard.yml`
job running `pipeline-cli fanout-guard check`.

**The honest limit of the publish check.** The guard verifies a fanned mutation's feature
*references* the publisher — it does not prove the publish is *correct* (right topic, right
frame, right condition). A feature-file-scoped reference check is a coarse floor, not a
semantic proof. That is deliberate: the guard's job is to make the **wholesale omission** — the
#1893–#1896 class, a fanned mutation that reaches for no publisher at all — loud, cheaply and
without false positives. The *shape* of a publish (which topic, gated on what) stays the
reviewer's and the integration test's job (`tests/integration/fate-live.test.ts`), exactly as
`.patterns/fate-live-views.md` already frames it. Making the floor a whole-feature reference
(not a per-mutation one) keeps it false-positive-free where a feature's fanned mutations share
a `*Live(...)` helper.

## Decision

Adopt option (b): a `pipeline-cli fanout-guard` CI guard backed by a declared
`fanned-mutations.ts` manifest.

- **Manifest** — `apps/web/worker/features/fate-live/fanned-mutations.ts` classifies every
  `entity.verb` mutation as `fanned` or not, with a rationale. It is the single source of the
  fanned/not decision, co-located with the live protocol it serves.
- **Guard** — `packages/pipeline-cli/src/tools/fanout-guard/` (pure `fanout-guard.ts`, IO
  `gate.ts`, CLI `command.ts`), registered in `pipeline-cli`'s registry. `pipeline-cli
  fanout-guard check` exits non-zero on: an unclassified mutation (drift), a fanned mutation
  whose feature omits the publish, or zero scope (fail-closed).
- **CI** — `.github/workflows/fanout-guard.yml` runs the check on every PR.
- **Working proof (the adopters)** — the manifest classifies the report / pano / sözlük fanned
  mutations (the Phase-2 features that publish) as `fanned: true`, and the guard confirms each
  publishes. Removing a publish from any of them turns the guard red — proved by the
  `fanout-guard.unit.test.ts` fixture pair (a fanned-with-publish member passes; a fanned-
  without-publish member fails).

## Consequences

- **The omission is loud twice** — once at authoring (a new mutation with no classification
  fails the drift check) and once at CI (a fanned mutation with no publish fails the publish
  check). The #1893–#1896 retrofit class is now caught before merge.
- **This is a control-plane (§CP) change.** The enforcement lives in `packages/pipeline-cli/`
  and `.github/workflows/`, so the PR that adds it is §CP — human-merge, not auto-shipped, per
  the control-plane boundary (ADRs [0053](0053-control-plane-boundary.md) /
  [0135](0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md)). The manifest
  file itself (`apps/web/worker/features/fate-live/fanned-mutations.ts`) is product code, but
  the guard + CI wiring that consumes it is control plane.
- **New fanned features must add a manifest row.** The cost of the guard is one manifest entry
  per new mutation — the conscious fanned/not decision the drift check forces. That is the
  point, not a tax: the decision was always required; the guard makes skipping it fail rather
  than ship a stale view.
- **The publish check is a floor, not a proof** (see the honest-limit note above). A fanned
  mutation that publishes to the *wrong* topic still passes the guard; that stays the
  reviewer's and the integration test's job. The guard removes the wholesale-omission class,
  which is where the real, invisible-by-construction failures lived.
- **Not retrofitting every feature here.** Per #1898's scope, this ADR + PR land the seam and
  prove it on the already-publishing adopters; the Phase-2 children (#1893–#1896) did the
  per-feature publish retrofits.
