---
id: 0015
title: Adopt fate's native protocol as the data layer
status: accepted
date: 2026-05-23
tags: [fate, architecture, api, frontend]
---

# 0015 — Adopt fate's native protocol as the data layer

## Context

The data layer is GraphQL Yoga on the worker and Relay on the SPA. We are
replacing it with [fate](https://github.com/usirin/fate), a Relay-inspired
typed data client: co-located views, a normalized cache, data masking, and a
compiler that hoists views into one request per screen — without GraphQL's
type system or query language. fate offers tRPC and GraphQL adapters, but
those are mapping layers over an existing server. We are not keeping a GraphQL
server, so neither adapter applies.

## Decision

The data layer is fate's **native protocol**, end to end. The backend serves
it via `createFateServer` mounted on a Hono route in the single worker
(`/fate`, plus `/fate/live`); the SPA consumes it via `react-fate`. No tRPC
adapter, no GraphQL adapter, no GraphQL Yoga. `/graphql` and `/graphql/schema`
are removed.

The detailed patterns this umbrella decision unfolds into live in
`.patterns/fate-*.md`; ADRs 0016–0023 record the load-bearing choices.

## Consequences

- **Easier:** one typed view/selection model shared client↔server; a
  normalized cache; no SDL; data masking by default.
- **Cost:** rewrite the protocol glue and the entire frontend data layer.
  fate is alpha — expect to track upstream churn.
- **Banned:** GraphQL schema/resolvers, GraphQL Yoga, Relay, and the fate
  tRPC/GraphQL adapters.
- The Effect domain layer (`.patterns/effect-*.md`, the feature services) is
  protocol-neutral and survives unchanged.
