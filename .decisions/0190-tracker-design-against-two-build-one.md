---
id: 0190
title: The `Tracker` service — design against two backends, build one now
status: accepted
date: 2026-07-16
tags: [crew, pipeline, effect]
---

# 0190 — The `Tracker` service — design against two backends, build one now

## Context

Wave 1 of the deterministic-crew-mechanics map ([#3247](https://github.com/kamp-us/phoenix/issues/3247)) introduces `Tracker`, an Effect service interface for the shared GitHub-issue tracker surface — issues, labels, comments, claims, maps — with **domain-shaped** signatures (`claim` / `apply-triage` / `post-verdict` / `graduate`) and **no GitHub semantics leaking into the signatures**. Epic [#3258](https://github.com/kamp-us/phoenix/issues/3258) builds `GithubTrackerLive` as the **sole** implementation now; the walking skeleton lands on child [#3262](https://github.com/kamp-us/phoenix/issues/3262).

A separate downstream epic — portable crew tracking, [#3256](https://github.com/kamp-us/phoenix/issues/3256) — will later plug non-GitHub adapters behind that same interface. The risk is ordering: if we shape `Tracker` around GitHub's data model today and only discover the portability constraints when #3256 starts, the interface has to be reshaped, breaking `GithubTrackerLive` and every call site. An Effect service interface is a `Context.Tag` contract every consumer binds against; reshaping it after it locks is the expensive change. The point of an interface is to be the stable seam, so the constraints that will bear on it must be validated **before** it locks, not after.

The two downstream targets from #3256 impose concrete data-model constraints:

- **Asana** — has no sub-issues and no GitHub-style label strings. So the interface must not assume sub-issue linking, nor plumb GitHub label-strings through its signatures.
- **local-markdown** — has no ACL trust root. So the interface must not bake in GitHub's ACL / CODEOWNERS trust assumptions (the review-authz trust root of ADR [0055](https://github.com/kamp-us/phoenix/blob/main/.decisions/0055-acl-sourced-review-authz.md)).

The founder ruled the boundary explicitly (2026-07-16): #3256 stays **downstream** — it does not supersede or reshape epic #3258. `Tracker` covers the **tracker surface only**. The merge/review substrate — the merge queue, §CP CODEOWNERS, the ADR 0055 ACL trust root — stays GitHub-native and is **never** put behind `Tracker`.

This is the durable rationale that the walking skeleton ([#3262](https://github.com/kamp-us/phoenix/issues/3262)) design-check AC cites, and that both #3262 and #3256 builders must respect. Grounding an Effect service this way — a single `Context.Tag` interface with domain verbs, one `Live` layer now, others plugged later — is the documented effect-smol service idiom (effect-smol `LLMS.md`, service/layer section); the deviation we are guarding against (leaking backend semantics into the tag) is exactly what that idiom warns off.

## Decision

**Design the `Tracker` service interface against two backends; build one.**

1. Wave 1 ships `GithubTrackerLive` as the sole implementation of `Tracker`. The interface carries **domain-shaped** signatures only (`claim`, `apply-triage`, `post-verdict`, `graduate`, and the issue/label/comment/map reads) — no GitHub types, label-strings, or sub-issue linking in any signature.
2. Before the interface locks, **validate it against the two #3256 portability targets' data-model constraints**: it must remain implementable over **Asana** (no sub-issues, no label-strings) and over **local-markdown** (no ACL trust root). If a signature can only be satisfied by GitHub, it is reshaped now, not after #3256 starts.
3. This design-check is an **acceptance criterion on child [#3262](https://github.com/kamp-us/phoenix/issues/3262)** (the Tracker walking skeleton). This ADR is the durable rationale that AC cites.
4. The boundary is fixed: **`Tracker` covers the tracker surface only.** The merge/review substrate — merge queue, §CP CODEOWNERS, the ADR [0055](https://github.com/kamp-us/phoenix/blob/main/.decisions/0055-acl-sourced-review-authz.md) ACL trust root — stays GitHub-native and is **never** placed behind `Tracker`. Epic #3256 is downstream of #3258; it does not supersede or reshape it.

## Consequences

- **#3256 can later plug Asana / local-markdown adapters without reshaping the interface** — the whole point of paying the design-check cost in Wave 1. The interface is the stable seam; adapters vary underneath it.
- The Wave-1 build carries a validation cost it would not otherwise: every `Tracker` signature must be checked against two backends it does not yet target. That check is an explicit AC on #3262, so it is enforced at authoring time, not deferred.
- **What is now banned:** GitHub semantics in `Tracker` signatures — no label-string plumbing, no sub-issue-linking assumption, no ACL/CODEOWNERS trust baked into the interface. A signature that only GitHub can satisfy is a design defect to be fixed before the interface locks.
- The merge/review substrate stays GitHub-native by design. Anyone reaching for "put the merge queue / §CP CODEOWNERS behind `Tracker` too" is out of scope — that boundary is deliberate, not an omission.
- Terminology guard: this GitHub-issue-layer `Tracker` is **not** the crew-MCP presence tracker of [#3219](https://github.com/kamp-us/phoenix/issues/3219), and its `claim` verb is **not** the crew-MCP live work-lease `Claim` of [#3228](https://github.com/kamp-us/phoenix/issues/3228) — same words, different layer. The disambiguation lives in the `.glossary/TERMS.md` `Tracker` row (landing in PR [#3272](https://github.com/kamp-us/phoenix/pull/3272)).

Vocabulary impact: no new term coined here — `Tracker` (the GitHub-issue-layer service) and its layer-disambiguation are coined and defined in the glossary via PR [#3272](https://github.com/kamp-us/phoenix/pull/3272); this ADR records the design rule over that already-named concept, and its terminology guard above points at that glossary row rather than re-coining it.
