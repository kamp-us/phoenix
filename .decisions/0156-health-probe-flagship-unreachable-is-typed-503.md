---
id: 0156
title: The health probe returns a typed 503 degraded body when Flagship is unreachable, not orDie→500
status: accepted
date: 2026-07-05
tags: [health, readiness, http, flagship, worker, observability, product-development-framework]
---

# 0156 — Health-probe Flagship-unreachable is a typed 503, not an orDie→500 defect

## Context

`GET /api/health` (`apps/web/worker/http/health.ts`) is the worker's readiness
probe. It drives one Flagship evaluation purely to assert binding reachability
(epic #488, #507): the read completing at all proves the `FlagshipClient` resolved
end-to-end through the worker, so the returned `HealthStatus.flagshipReachable` is
`true`. Before this decision the handler did:

```ts
yield* flagship.getBooleanValue("phoenix-health-probe", false).pipe(Effect.orDie);
return new HealthStatus({status: "ok", environment, flagshipReachable: true});
```

Two grounded facts about the seam (both verified in source, per the CLAUDE.md
"ground falsifiable claims" rule):

- **`FlagshipError` is a promise-reject-only channel.** In the alchemy source
  (`Cloudflare/Flagship/ReadFlags.ts` `ReadFlagsClient` docblock):
  "Flagship evaluation never throws — it falls back to the provided `defaultValue`
  — so the `FlagshipError` channel only surfaces unexpected runtime failures (e.g.
  a misconfigured binding)." So the only way `getBooleanValue` fails is an
  unreachable/misconfigured binding, never a normal evaluation.
- **Flags fail-closed.** The feature-facing evaluator (`features/flagship/Flags.ts`
  `buildRealFlags`) `catch`es any `FlagshipError` to the caller's supplied default,
  so a Flagship outage degrades safe — the worker keeps serving with flags at their
  defaults. `Flags.getBoolean`'s public error channel is therefore `never`.

Given those two facts, the pre-decision `orDie` had two defects:

1. It turned `FlagshipError` into an Effect **defect → HTTP 500**, indistinguishable
   from any other handler crash. An operator or the integration harness
   (`tests/integration/_integration.ts` `healthReady`) could not tell
   "Flagship binding unreachable" from a generic worker crash.
2. It made `HealthStatus.flagshipReachable` **dead** — the field could never be
   `false`, because the failure path never reached the `HealthStatus` return. The
   schema carried a readiness signal the code could never emit.

`ConfigError` (a malformed `ENVIRONMENT`/`AppConfig` value) is a different animal:
that is a genuine handler defect — the env is broken — not a representable degraded
state. It stays `orDie`→500.

## Decision

Split the two error channels by what they mean:

- **`ConfigError` (malformed env / `AppConfig`) → keep `orDie`→500.** A real handler
  defect; the narrow-error-channel discipline holds.
- **`FlagshipError` (Flagship unreachable) → return a typed 503 degraded body.**
  Catch the `FlagshipError` and return a `HealthDegraded` body
  (`status:"degraded"`, `flagshipReachable:false`) at HTTP **503**
  (not-ready-but-alive). The reachable path is unchanged: 200
  `{status:"ok", flagshipReachable:true}`.

`HealthDegraded` is a `Schema.TaggedErrorClass` whose `status` and
`flagshipReachable` fields are pinned to `Schema.Literal("degraded")` /
`Schema.Literal(false)` — the only values a degraded body can hold, so an
"ok-looking" degraded response is unrepresentable. The 503 status is carried by the
schema's `httpApiStatus: 503` annotation; `HttpApiSchema.getStatusError` reads it
(an unannotated error would encode as 500). The endpoint declares it via
`error: HealthDegraded`, so the typed non-200 is part of the route's HTTP contract,
not an ad-hoc response.

**Deciding rationale.** Because flags fail-closed, Flagship-unreachable is a
**known, representable degraded-readiness state**, not an unhandled defect. `orDie`→500
wrongly conflates dependency-degradation with a handler crash and defeats the body's
own `flagshipReachable` field. A typed 503 makes the state legible to
orchestration/alerting under standard readiness semantics: **200 ready · 503
not-ready-but-alive · 500 only for real defects.**

### What `flagshipReachable: false` means, and how `healthReady` reads it

`flagshipReachable: false` means the `FlagshipClient` binding did not resolve
end-to-end for this request (an unreachable/misconfigured binding) — the worker is
degraded but alive. It does **not** report the value of any flag.

The integration harness readiness predicate (`_integration.ts` `healthReady`) already
requires **a 200 whose JSON `status === "ok"`**; a 503 degraded body is therefore not
ready → the deploy-warm poll keeps retrying, which is correct: a degraded worker is
not a ready worker. No harness change is required by this decision — the existing
predicate already reads the readiness signal the right way; ADR 0156 only makes the
degraded case a typed 503 instead of an opaque 500, so `healthReady` distinguishing
it is now a semantic contract, not an accident.

## Alternatives weighed

- **(a) Keep `orDie`→500 (status quo) — rejected.** Simplest and already live, but
  the readiness signal is opaque: an unreachable dependency is indistinguishable from
  a generic handler crash, and `flagshipReachable: false` is unreachable dead code.
  It conflates dependency-degradation with a defect.
- **(b) Typed 503 readiness body — CHOSEN.** See Decision. Widens the handler's error
  channel by exactly one typed, HTTP-annotated error, which is the cost; the payoff is
  a legible readiness contract and a live `flagshipReachable` field.
- **(c) 200 + degraded body — rejected.** Returning `{status:"degraded"}` at HTTP
  200 keeps the field alive but breaks readiness semantics: a readiness probe must
  signal degraded via a **non-200** so orchestration/load-balancers can act on the
  status code without parsing the body. A 200 that says "degraded" is a trap for any
  probe that only inspects the status line.

## Consequences

- `HealthStatus.flagshipReachable` is now a live signal — `true` on the 200 path,
  and the `false` reading is its own typed body, `HealthDegraded` (503).
- The health endpoint's HTTP contract gains one declared error response (503); the
  route is unit-covered at the local tier (`http/health.unit.test.ts`: reachable →
  200, `FlagshipError` → typed 503) and black-box over HTTP in the CI-only
  integration tier (`flagship-binding.test.ts`, ADR 0154).
- The `ConfigError`→500 discipline is unchanged; only the Flagship channel moved.
- Future changes to the health route now have a recorded contract to respect:
  Flagship-unreachable is 503-degraded, malformed-env is 500-defect, reachable is
  200-ok.
