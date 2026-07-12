# Runbook: live plane degraded

The live plane is phoenix's real-time push path: the unified `LiveDO` fans a mutation's
invalidation out over SSE so every open view updates without a refresh (ADRs
[0023](../.decisions/0023-live-views-sse-livedo.md) →
[0025](../.decisions/0025-split-livedo-connection-topic.md) →
[0037](../.decisions/0037-unified-void-aligned-live-do.md), on fate's native SSE +
POST protocol, ADR [0034](../.decisions/0034-fate-native-sse-protocol.md)). One `LiveDO`
class plays **two roles** — a `connection:` instance owns a client's held SSE stream, a
`topic:` instance owns a subscriber set and fans a publish to it. Live is a **core UX
tenet**, not a nice-to-have (ADR [0157](../.decisions/0157-realtime-is-a-core-ux-tenet.md)):
"degraded" here means views that others can change stop updating live, which users read as
staleness, not an outage.

This runbook covers **the live plane being degraded while the app is otherwise up** — stale
views and `LIVE_UNAVAILABLE` 503s from `/fate/live`. If the *whole* app is unreachable
(assets 5xx, `/fate` data reads failing, the worker itself down), that is a different
failure — reach for [Cloudflare down](./runbook-cf-down.md) instead. How the live code is
shaped is [`.patterns/fate-live-views.md`](../.patterns/fate-live-views.md) and
[`.patterns/effect-sse-externally-driven.md`](../.patterns/effect-sse-externally-driven.md);
this is how to operate it when it breaks. When this runbook and the source disagree, the
source wins — fix the runbook.

## Symptoms

Two distinct signals select this runbook. Which one you see narrows the cause before you
touch anything:

- **Stale live views, *no* errors.** A row another client just created (a pano post, a
  comment, a sözlük definition) does not appear until the reader manually refreshes; the
  page is otherwise healthy — data reads (`/fate`) return, navigation works, nothing 500s.
  The live *push* is missing, not the data. This is the more common and more insidious
  symptom because nothing errors — see [triage](#triage) for the candidate causes.
- **`LIVE_UNAVAILABLE` 503 from `/fate/live`.** A `GET`/`POST /fate/live` returns the fate
  error envelope `{"error":{"code":"LIVE_UNAVAILABLE", …}}` with HTTP **503**. This is the
  route's *graceful* degradation path (`apps/web/worker/features/fate-live/route.ts`), not a
  crash: a cold-DO transport failure that survived the bounded worker-seam retry surfaces as
  a typed `LiveTransportError` → 503, by design, because the client's live pin retries the
  whole connect on the next mount
  ([`cold-start-retry.ts`](../apps/web/worker/features/fate-live/cold-start-retry.ts)). A
  raw **500** from `/fate/live` is *not* this path — that is an unhandled defect, escalate it.

Distinguishing **degraded live fan-out** from **app down**: the live plane is degraded when
`/fate` data reads and asset loads still work and only the live push is stale or 503-ing. If
`/fate` reads themselves fail, or the SPA won't load, the worker or Cloudflare is down —
that is [Cloudflare down](./runbook-cf-down.md), not this runbook.

## Preconditions

- **Read access to the production worker's logs.** Live-tail via the alchemy/wrangler
  toolchain against the production stage (ADR
  [0032](../.decisions/0032-alchemy-beta45-and-dev-model.md)); you are diagnosing, not
  deploying, so no secrets are needed to observe.
- **Deploy access to the `web` worker**, *only if* you intend to run the one real recovery
  lever below (a redeploy). Deploy is alchemy-managed — `pnpm deploy` runs `alchemy deploy`
  against the production stage (ADRs 0026–0032); there is no `wrangler.jsonc`.
- **Know whether Sentry is live.** Worker/SPA error capture only activates when a DSN is
  provisioned at deploy — the integration ships **inert without a DSN**
  ([`.patterns/sentry.md`](../.patterns/sentry.md), ADR
  [0118](../.decisions/0118-error-crash-monitoring-sentry-saas.md)). If no DSN is set,
  Sentry will be silent and worker log-tail is your only live signal; don't wait on a
  Sentry issue that will never arrive.
- **Capture the symptom first.** Note whether you see stale-without-503 or `LIVE_UNAVAILABLE`
  503s, and a concrete reproduction (which entity, which view) before you change anything —
  the two symptoms route to different causes.

## Procedure

### Triage

Branch on the symptom captured above.

**`LIVE_UNAVAILABLE` 503s** are the transport channel: a `connection:`/`topic:` `LiveDO`
instance was cold or briefly unreachable and the bounded cold-start retry (~1.5s worst case)
was exhausted, so the route returned the graceful 503
([`cold-start-retry.ts`](../apps/web/worker/features/fate-live/cold-start-retry.ts)). A
*transient* burst around a deploy or an idle-eviction warm-up is **expected** and
self-heals — the live pin re-opens on the next mount. Escalate only when 503s are
**sustained** (not clearing as clients remount) or you see raw **500s** from `/fate/live`
(an unhandled defect, outside the graceful path).

**Stale views without 503s** is the fan-out channel — the stream is up but a publish never
reached it. Rank the candidates:

1. **An omitted `/fate/live` publish (the prime suspect).** A `Fate.mutation` that writes a
   fanned entity (`Post` / `Comment` / `Definition`) must publish the invalidation through
   `WorkerLivePublisher` after its write; omitting it is **invisible at the mutation site**
   (the publisher's error channel is `never`) and silently staleness-breaks every other
   client's view — the exact failure mode ADR
   [0155](../.decisions/0155-fanned-mutation-publish-guard.md) and the `fanout-guard` CI
   check exist to stop. If stale-without-503 is scoped to **one mutation** (e.g. only new
   comments go stale, everything else updates live), suspect a fanned mutation that shipped
   without its publish — cross-check
   [`apps/web/worker/features/fate-live/fanned-mutations.ts`](../apps/web/worker/features/fate-live/fanned-mutations.ts).
   This is a **code defect**, not an operational one: the fix is the missing publish, not a
   runbook lever (see [rollback / escalation](#rollback--escalation)).
2. **The publish/register race under load.** A create-mutation's fire-and-forget publish
   lists the topic's subscribers **once**; if a subscriber's `register` RPC hasn't persisted
   yet, the fan-out set is empty and the event delivers to nobody (v1 live is best-effort, no
   replay). Under load `register` slows and the publish loses the race — the mutator's own
   view waits on a push that never arrives (`.patterns/fate-live-views.md` §the register
   race; #711/#714). This looks like *intermittent* staleness that worsens with traffic.
3. **A torn-down live pin.** One always-on subscription (the global live pin, ADR
   [0094](../.decisions/0094-app-lifetime-global-live-pin.md)) keeps the shared `EventSource`
   alive across mutation churn; if it isn't mounted (anonymous client, a regression in
   `FateProvider`), the stream refcount can hit zero mid-churn and a publish targets a dead
   connection. This is client-side and reproduces per-session.

### Where to look

- **Worker logs** — live-tail the production worker (alchemy/wrangler tail, ADR 0032) and
  watch `/fate/live`: `LIVE_UNAVAILABLE` lines confirm the transport channel; their absence
  during a stale-view report points at the fan-out channel (an omitted/lost publish), not a
  transport failure.
- **Sentry** — if a DSN is provisioned, an unhandled `/fate/live` **500** (not the graceful
  503) surfaces as a captured issue at the worker request boundary
  ([`.patterns/sentry.md`](../.patterns/sentry.md)). Remember it is inert without a DSN.
- **The `LiveDO`** — the connection role owns the held SSE stream and the subscription map;
  the topic role owns the subscriber set it fans to (`.patterns/fate-live-views.md`
  §topology). A `topic:` instance is not pinned by an open stream, so it evicts between a
  publish and a later register — the storage-backed replay buffer, not an in-memory one, is
  what closes that gap.

### The levers that exist today

Be honest about the toolkit — it is deliberately small, and inventing controls that don't
exist would make this runbook lie:

- **Redeploy the `web` worker.** `pnpm deploy` (`alchemy deploy`, production stage) replaces
  the running worker, which recreates the isolate and its `LiveDO` bindings and clears any
  wedged warm state. This is the one blunt operational lever for a genuinely stuck transport
  channel (sustained 503s not clearing on remount).
- **Let the live pin re-open.** By design the client re-opens the whole connect on the next
  session mount, so a **client refresh** re-establishes a stream that hit a transient 503.
  For a transient warm-up burst this is the *only* action needed — no operator lever at all.

**Levers that do not exist yet — state this plainly, do not improvise.** There is **no**
per-`LiveDO`-instance restart, **no** live-plane feature flag or kill-switch, **no** fan-out
circuit breaker, and **no** publish-replay/backfill lever. A stale-without-503 caused by an
omitted publish is **not recoverable by any operational lever** — it is a code bug, and the
fix is code (the missing publish), routed as below. Building finer live-plane recovery levers
is out of scope for this runbook; if the incident shows one is needed, file it (see
[escalation](#rollback--escalation)).

## Verification

You've recovered when:

- **A live view updates without a manual refresh.** Open the affected view in one client,
  make the triggering change in another, and confirm the row appears with no refresh — the
  end-to-end fan-out is the real check, not a proxy metric.
- **`GET /fate/live?connectionId=…` returns `text/event-stream`, not 503.** A fresh connect
  opens the stream (the `: connected` frame) instead of the `LIVE_UNAVAILABLE` envelope.
- **`LIVE_UNAVAILABLE` has stopped appearing in the worker logs** for new connects (a
  lingering line from before the fix is not a regression — confirm by timestamp).

If the symptom was stale-without-503 from an omitted publish, verification is **the code
fix's** review + the `fanout-guard` check going green, not a redeploy — nothing to verify
operationally because there was no operational fault.

## Rollback / escalation

- **Back out a redeploy.** If a redeploy makes things worse, roll the worker back to the
  prior known-good version via the alchemy deploy model (ADR 0032) — a redeploy is
  reversible, it does not mutate data.
- **A cause in code, not ops → route it as code.** If triage lands on an omitted `/fate/live`
  publish (candidate 1) or the register race (candidate 2), there is no operational fix:
  file a `report`-skill issue against the specific mutation/feature so it enters triage,
  and — for an omitted publish — flag that `fanout-guard` should have caught it, so the gap
  in the guard (or a mutation missing from the manifest) is investigated too. Do not paper
  over a fan-out bug with repeated redeploys.
- **Escalate the platform substrate.** The fate/`LiveDO` substrate is platform/infra, where
  engineering leads (ADR [0078](../.decisions/0078-product-driven-decisions-by-default.md)) —
  sustained `LIVE_UNAVAILABLE` 503s that a redeploy doesn't clear, raw 500s from
  `/fate/live`, or a suspected `LiveDO` topology/eviction fault (the connection/topic role
  seam) is beyond this runbook's levers and belongs with whoever owns the live substrate.
