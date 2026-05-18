---
id: 0013
title: Input validation lives in service methods, not the resolver layer
status: accepted
date: 2026-05-17
tags: [backend, effect, validation, architecture]
---

# 0013 — Input validation lives in service methods, not the resolver layer

## Context

An earlier draft of the schema-validation pattern proposed extending the GraphQL resolver wrapper (`worker/graphql/resolver.ts`) to accept an `input` schema and decode args automatically — `resolver({input: SomeSchema}, body)`. The intent was DRY: avoid `Schema.decodeUnknown` boilerplate at the top of every resolver body.

That proposal had two problems that surfaced under review:

1. **GraphQL resolvers aren't a trust boundary.** GraphQL Yoga validates args against the SDL before the resolver runs. Re-validating with Schema duplicates what's already enforced. The SDL is the wire contract; additional constraints are domain rules, not boundary rules.
2. **It splits validation ownership.** With a resolver-layer schema, the resolver has to know "does this method need validation, and what's the schema?" Service methods become callable from contexts that didn't validate (admin routes, tests, scripts) — those callers would either re-validate or accept invalid input.

The architectural commitment from [0010](0010-effect-context-service-backend.md) is that services own their own invariants. Input validity is an invariant. Pushing it into the resolver violates that.

## Decision

**All semantic input validation for service methods lives inside the service method's body.** Resolvers pass SDL-typed args directly to service methods. No Schema validation at the resolver layer; no resolver wrapper extension.

Inside service methods:

- **Simple checks** (non-empty string, length cap, regex pattern, ownership match) use plain TS with `Data.TaggedError` instances returned as Effects. Pattern in [feature-services.md](../.patterns/feature-services.md) — `validateBody` as a closure helper that returns either the cleaned value or a tagged error.
- **Complex validation** (nested shapes, conditional fields, branded primitives) may use `Schema.decodeUnknown` *inside the service's closure*, treating the schema as an implementation detail of the method. The schema doesn't appear in the service's public signature.

Service methods' `E` channels surface the validation errors as tagged failures; the resolver wrapper maps tags to wire codes in `encodeMutationError`. Callers from any context (GraphQL resolvers, admin routes, tests, scripts) get the same validation guarantees because the service owns them.

**Schema is still the right tool at actual trust boundaries:**

- Admin route bodies — Hono's `c.req.json()` returns `unknown`; the route handler decodes via Schema before calling the admin service method.
- External API responses — phoenix-initiated fetches return untyped data.
- Persisted JSON columns — if/when phoenix stores arbitrary JSON in D1.

These are genuine boundaries where untyped data enters the worker. The resolver layer isn't one of them.

## Consequences

**Easier:**
- Single owner of input validity per method. Refactoring validation rules touches one file.
- Service method signatures expose the validation error contract explicitly (e.g. `Effect<Result, BodyRequired | BodyTooLong | DefinitionNotFound | ...>`). Callers and the resolver wrapper handle the same error union.
- The resolver wrapper stays narrow — just runs the Effect and maps errors. No schema-aware overloads.
- Service methods are honestly callable from non-resolver contexts (admin, tests, scripts) without "did the caller validate?" doubt.

**Harder / costlier:**
- Validation code lives in service files, which grow longer per method. Mitigated by extracting genuinely-shared validators to `worker/shared/*` (per the helper-extraction policy).
- No DRY for repeated validation patterns across services. If five mutations all check "body is non-empty and ≤ 10,000 chars," that's five tagged-error checks. Acceptable cost — the alternative (a shared Schema) splits the invariant from its enforcer.

**Now banned:**
- `Schema.decodeUnknown` at the top of a GraphQL resolver body.
- Extending the resolver wrapper to accept input schemas as a typed option.
- Validation rules duplicated across the resolver and the service — pick one (the service).

**Patterns:** see `.patterns/effect-schema-validation.md` for where Schema does apply (admin boundaries, external APIs), `.patterns/feature-services.md` for the in-service validation idiom, `.patterns/effect-errors.md` for the tagged-error model the validation rests on.
