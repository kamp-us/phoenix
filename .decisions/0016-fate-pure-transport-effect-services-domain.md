---
id: 0016
title: fate is pure transport; Effect services stay the domain
status: accepted
date: 2026-05-23
tags: [fate, effect, architecture, sources]
---

# 0016 — fate is pure transport; Effect services stay the domain

## Context

fate ships an opinionated Drizzle source adapter (`createDrizzleSourceAdapter`)
that queries the database directly and resolves views from rows. phoenix
already has its whole domain in Effect `Context.Service`s over Drizzle —
keyset pagination, validation, the vote/karma engine, authorization. Using
fate's adapter would bypass that and re-home domain logic into view fields.

## Decision

fate never touches the database. Every read and write goes through an Effect
service method:

- We hand-build a `SourceResolver` whose `byId`/`byIds`/`connection`
  executors delegate to service methods (built from `createSourceDefinition`,
  `getDataViewSourceConfig`, `createSourceRegistry`). `createDrizzleSourceAdapter`
  is never used.
- Resolvers and source executors are Effect generators wrapped by a bridge
  helper family — `fateQuery` / `fateList` / `fateMutation` / `fateSource` —
  that runs them through the per-request runtime and maps failures to wire
  errors. **No `runtime.runPromise*` outside the bridge.**
- Every type reachable as a relation implements `byIds` (a `WHERE id IN (...)`
  over the read path) to avoid N+1.

## Consequences

- **Easier:** domain logic stays in one place; services are untouched;
  tracing and error mapping are consistent with the rest of the backend.
- **Harder:** more wiring than the adapter; services gain `getXsByIds`
  methods where missing.
- **Banned:** the fate Drizzle adapter, database access inside views, and raw
  runtime calls in feature/resolver code.
- See `.patterns/fate-sources.md` and `.patterns/fate-effect-bridge.md`.
