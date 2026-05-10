---
id: 0003
title: Pasaport runs as a singleton Durable Object
status: accepted
date: 2026-05-09
tags: [auth, durable-objects, pasaport]
---

# 0003 — Pasaport runs as a singleton Durable Object

## Context

Pasaport (Better Auth + drizzle on sqlite-in-DO) is bound and addressed via
`env.PASAPORT.idFromName("kampus")` — one global instance for the entire worker.

Cloudflare's [Rules of Durable Objects][rules] explicitly names this shape an
anti-pattern: *"Do not create a single 'global' Durable Object that handles all
requests."* The same page recommends D1 for *"shared, read-heavy data accessed
by many independent entities,"* which describes auth tables (read on every
authenticated request, written by login/signup/password-change paths from
across the worker).

We considered moving Pasaport to D1 now, and rejected it for the moment:

- Better Auth's drizzle adapter assumes a single DB and performs cross-user
  lookups (e.g. find user by email). Per-user DO sharding fights the adapter
  hard; the natural alternative under the Rules is therefore D1, not sharded DOs.
- The current singleton works end-to-end: sign-up, sign-in, bearer-token
  validation through `/graphql`, frontend `useSession()`, sign-out. Smoke-tested
  via curl + Playwright on 2026-05-09.
- kamp.us is a small Turkish dev community. Realistic peak request rate is
  well under the documented ~500–1,000 req/sec single-DO ceiling.
- D1 migration costs: redo Better Auth schema on D1 dialect, change wrangler
  bindings + `Pasaport.ts` plumbing, re-validate the entire auth flow.

[rules]: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/

## Decision

Pasaport stays as a singleton DO addressed by `idFromName("kampus")`. We
accept that this matches the documented anti-pattern, and treat "one auth
realm = one coordination instance" as the principled exception we're claiming.

This decision is local to Pasaport. Other product DOs (Sozluk, etc.) MUST NOT
use the singleton shape — they shard by their natural coordination atom
(per-term, per-post, per-room).

## Consequences

- All auth writes serialize through one DO instance pinned to one CF colo.
  Acceptable at community scale; will become a real ceiling under load.
- Cross-feature SQL joins against auth data (e.g. "list sozluk definitions
  with their author's display name") are not possible — sozluk/pano either
  RPC into Pasaport per row, or denormalize a cached snapshot of user fields.
- Future agents: do not copy the singleton pattern for new DOs. Cite
  this ADR if you're tempted.
- Revisit when any of the following lands:
  - Sustained traffic approaches the per-DO request ceiling.
  - A migration to D1 is justified by a concrete cross-feature join need.
  - Better Auth ships an adapter that's friendly to per-user-DO sharding.
- When superseded, write a follow-up ADR documenting the migration and mark
  this one `superseded`.
