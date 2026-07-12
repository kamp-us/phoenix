# Capacity baseline

The measured capacity ceilings of the live plane — the `LiveDO` SSE fan-out (ADRs
[0023](../.decisions/0023-live-views-sse-livedo.md)/[0025](../.decisions/0025-split-livedo-connection-topic.md)/[0037](../.decisions/0037-unified-void-aligned-live-do.md))
— plus the method that produces each number, so the baseline is reproducible. It records
limits, not remedies: acting on a ceiling (tuning a budget, sharding a hot topic,
autoscaling) is out of scope here (epic [#2568](https://github.com/kamp-us/phoenix/issues/2568)).

## How the numbers are produced — the audit-harness load dimension

The reproducible method drives load through the existing ephemeral-stage audit harness (the
rite-audit family, epic [#1510](https://github.com/kamp-us/phoenix/issues/1510)):
[`@kampus/audit-stage`](../packages/audit-stage/README.md) provisions an **isolated,
disposable** stage on the dedicated `preview` deploy class (ADR
[0088](../.decisions/0088-preview-deploy-environment.md)) via `alchemy deploy --stage <name>`,
preview-seeds it, mints a login-able test-mod, runs an injected hook, and **tears the stage
down on every exit path** — so a load run never leaks a live stage.
[`@kampus/audit-run`](../packages/audit-run/README.md) is the single-entry command that wraps
that lifecycle around an injected `--walk` seam.

Capacity measurement is a **load dimension** run through that same `--walk` seam: a driver
opens N concurrent `GET /fate/live?connectionId=…` SSE streams against the deployed stage
(each is one connection-role `LiveDO`), subscribes them to a shared hot topic, drives
mutations that fan out through that topic, and records the wire-level outcome (frames
delivered, drops, latency). The stage's own worker telemetry
([`apps/web/worker/features/telemetry`](../apps/web/worker/features/telemetry)) and the
`/fate/live` response codes are the instruments — the same observability surface the
2026-07-06 read-path investigation used (see the baseline recorded on
[#2707](https://github.com/kamp-us/phoenix/issues/2707)). Run from the repo root with the
account credentials in the environment, never in source:

```bash
node packages/audit-run/src/bin.ts run \
  --walk '<capacity-load driver: opens N SSE streams, fans mutations, prints the wire outcome>' \
  --stage capacity-<date>
```

> **Honest status of the numbers below — method-derived, not yet stage-measured.** A live run
> needs a real deployed `preview` stage, which needs the Cloudflare account + `alchemy` +
> better-auth credentials (`$CLOUDFLARE_ACCOUNT_ID`, `$CLOUDFLARE_API_TOKEN`,
> `$ALCHEMY_PASSWORD`, `$BETTER_AUTH_SECRET`) — absent in the environment this doc was authored
> in, so no live measurement was taken. The harness **has no capacity/load dimension yet** (its
> `--walk` seam today drives the functional rite-audit, not a load driver), so establishing the
> live baseline is: add the load-driver walk, then run it against a stage. Each ceiling below is
> therefore **derived from the in-source fan-out budgets** (`defaultLiveLimits` in
> [`apps/web/worker/features/fate-live/protocol.ts`](../apps/web/worker/features/fate-live/protocol.ts))
> and the DO execution model, and is labelled **(derived — pending live measurement)**. When the
> load dimension runs, replace each derived value with the measured one and its stage/date; the
> conditions and degradation modes below are the source-grounded expectations to measure against.

## The hot topic

The single busiest fan-out target is the pano feed's global connection topic, `posts`: every
pano client's feed view subscribes to it, and the membership/field mutations classified in
[`apps/web/worker/features/fate-live/fanned-mutations.ts`](../apps/web/worker/features/fate-live/fanned-mutations.ts)
(`createPost`, `deletePost`, vote/save changes) all publish to it (ADR
[0155](../.decisions/0155-fanned-mutation-publish-guard.md)). One topic-role `LiveDO` owns its
whole subscriber registry and fans each publish out, so `posts` is where concurrency and
throughput bind first.

## Max SSE connections per `LiveDO`

**(derived — pending live measurement)** A single **topic-role** `LiveDO` sustains up to
`maxSubscriptionsPerTopic` = **256** concurrent subscriber rows for one topic (e.g. `posts`)
before it rejects further registrations. Because each connection-role `LiveDO` holds exactly
one client's SSE stream, this is effectively the ceiling on concurrent clients a single hot
topic fans to. A connection-role instance also caps at `maxSubscriptionsPerConnection` = **256**
distinct subscriptions on its one stream.

- **Method** — the load driver opens SSE streams (incrementing N) all subscribed to one topic
  key, and reads the `POST /fate/live` subscribe result (`ok`) plus telemetry to find the N at
  which registration starts failing.
- **Conditions / assumptions** — one topic key; the default per-request budgets
  (`defaultLiveLimits`) threaded by [`route.ts`](../apps/web/worker/features/fate-live/route.ts)
  and unchanged; a single topic DO (no sharding). Cloudflare runs each DO single-threaded, so
  one topic instance is the serialization point regardless of client count.
- **Degradation at the ceiling** — the 257th subscriber's `register` returns `{ok: false}`
  (`survivors.length >= maxSubscriptionsPerTopic`, `live-do.ts`) — void's "topic full" 409
  equivalent. Existing subscribers are unaffected; the new client silently gets no live view
  (its subscribe result is `ok: false`), which is the observable symptom to alert on.

## Hot-topic publish throughput

**(derived — pending live measurement)** Invalidations/sec a single topic DO's fan-out
sustains. Each `publish` (`live-do.ts`) allocates a monotonic seq, lists the subscriber rows,
groups them by connection, and fires the cross-role `deliver` RPCs **concurrently**
(`concurrency: "unbounded"`), each bounded by `deliveryAttemptTimeoutMs` = **1500 ms**, then
appends one frame to the replay ring. Throughput is bound by the single-threaded topic DO's
per-publish work (registry list + fan-out + one buffer write), which grows with subscriber
count — so throughput and the 256-subscriber concurrency ceiling are coupled: the hotter the
topic, the fewer publishes/sec it clears.

- **Method** — with N subscribers registered, the driver fires a known rate of fanned
  mutations at the topic and measures sustained delivered-frames/sec (from the subscribers'
  wire reads) versus offered rate, finding the publish rate at which the topic DO falls behind.
- **Conditions / assumptions** — measured at a stated subscriber count N (throughput is
  meaningless without it); default budgets; frames under `maxEncodedEventSize` = **64 KB** (an
  oversized frame is dropped as not-delivered, not stale). A publish rides the request's
  `waitUntil` off the mutation path, so it never blocks the committing mutation — throughput
  here is the fan-out plane's, not the write path's.
- **Degradation at the ceiling** — a `deliver` that exceeds 1500 ms (or a connection whose
  dropping queue is full — see below) is treated as unreachable/stale and its rows are reaped;
  under sustained overload publishes queue behind the single-threaded DO and per-client
  invalidation latency climbs, i.e. clients see progressively staler views before any error.

## Feed p95 under load

**(derived — pending live measurement)** The p95, under concurrent load, of the wall time from
a fanned mutation committing to a subscribed client receiving the invalidation frame on its SSE
stream. Governed by the same publish → concurrent-`deliver` path; the per-connection budget that
bounds a slow/absent consumer is `maxQueuedEventsPerConnection` = **100** (a **dropping** queue —
`Queue.dropping`, `live-do.ts`).

- **Method** — under the load profile (N subscribers, a fixed mutation rate), the driver
  timestamps each mutation's commit and the matching frame's arrival per subscriber, and reports
  the p95 of that delta. Aligns with #2707's telemetry/wall-time method on the read paths.
- **Conditions / assumptions** — a stated N and mutation rate; healthy consumers reading their
  streams promptly (a stalled consumer degrades its own latency independently via queue drops);
  default budgets. Report p95 with the N and rate it was measured at — it is not a
  load-independent constant.
- **Degradation at the ceiling** — once a client's queue reaches 100 unread frames, the next
  `offer` returns false: the connection's stream is closed and its row marked stale (void's 410
  on queue-full), so a client that can't keep up is dropped rather than allowed to unbound the
  DO's memory. p95 for healthy clients degrades gracefully as the single-threaded topic DO
  serializes more fan-out work before the queue-full cutoff engages.

## Assumptions, stated once

- All ceilings assume the **default** `defaultLiveLimits` budgets threaded by `route.ts`
  unchanged; a deployment that overrides them re-baselines every number here.
- One topic DO per topic key, **no sharding** — the hot-topic numbers are per single instance.
- Cloudflare Durable Objects execute **single-threaded** per instance (ADRs
  [0028](../.decisions/0028-effect-durable-object-model.md)/0037), so a topic DO is the
  serialization point its subscribers share — the root cause coupling concurrency, throughput,
  and latency above.
- The baseline is the live SSE fan-out plane only; the authed read-path latency baseline is the
  separate concern recorded on [#2707](https://github.com/kamp-us/phoenix/issues/2707).
