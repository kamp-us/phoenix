# Sentry error/crash monitoring — the both-tiers capture seam

How Sentry is wired and used in phoenix: one options idiom shared across the worker and the
SPA, the worker's request-boundary capture seam, and the invariant that the whole integration
ships **inert until a DSN is provisioned**. This is the **how-the-code-is-shaped** doc; the
*why* (why Sentry SaaS, why both tiers, why US region, the GlitchTip escape hatch) is ADR
[0118](../.decisions/0118-error-crash-monitoring-sentry-saas.md) — link there, don't re-derive it.

Ground truth is the code under `apps/web/src/lib/sentry.ts` (SPA), `apps/web/worker/lib/`
(`sentry.ts`, `sentry-capture.ts`, `sentry-effect.ts`), and the request seam in
`apps/web/worker/index.ts`, plus the installed SDKs — `@sentry/cloudflare`, `@sentry/react`,
`@sentry/effect`, and their shared `@sentry/core`, all pinned via `catalog:` at **10.62.0**
(`pnpm-workspace.yaml`). When this doc and the source disagree, the source wins — fix the doc.

## The wiring at a glance

| Piece | Where | What it is |
|---|---|---|
| `sentryEnabled(dsn)` | `src/lib/sentry.ts`, `worker/lib/sentry.ts` | the single DSN gate — the inert switch both tiers check |
| `browserOptions` / `workerOptions` | `src/lib/sentry.ts`, `worker/lib/sentry.ts` | the shared options shape (`dataCollection`, no `beforeSend`), one per tier's SDK type |
| `initSentry` / `captureBoundaryError` | `src/lib/sentry.ts` | SPA init (`main.tsx`) + the `Screen.tsx` error-boundary forward |
| `wrapRequestHandler` seam | `worker/index.ts` | the worker's only workerd-safe init path — real client init + isolate-safe transport + flush |
| `captureUnhandled` / `shouldCaptureCause` | `worker/lib/sentry-capture.ts` | the explicit issue-capture at the Effect router seam (the #1502 gap this closes) |
| `SentryEffectLive` | `worker/lib/sentry-effect.ts` | the `@sentry/effect` Tracer + Logger isolate-level layer (spans + breadcrumbs, **not** issues) |
| `SENTRY_DSN` / `VITE_SENTRY_DSN` | `worker/config.ts`, `deploy.yml` | the worker `secret_text` binding vs the SPA build-time Vite var — production stages only |

## The inert-without-DSN invariant (ADR 0118)

Both tiers ship **provably inert** until a DSN is provisioned — no init, no client, no capture,
no network, no throw. This is load-bearing: the SDKs are wired and merged into the code today,
but stay dormant, so the integration activates only when the DSN variable is set at deploy
(production stages only — `deploy.yml` gates `VITE_SENTRY_DSN`/`SENTRY_DSN` on
`ENVIRONMENT == 'production'`). The single gate is `sentryEnabled`, identical on both tiers:

```ts
// worker/lib/sentry.ts (mirrored in src/lib/sentry.ts) — the one inert switch
export function sentryEnabled(dsn: string | undefined): dsn is string {
	return typeof dsn === "string" && dsn.trim().length > 0;
}
```

- **SPA:** `initSentry` and `captureBoundaryError` (`src/lib/sentry.ts`) early-return on a
  false gate — `@sentry/react`'s `init`/`captureException` are never touched. The DSN is read
  from a build-time Vite env (`import.meta.env.VITE_SENTRY_DSN`), a public client-side value.
- **Worker:** inertness is **structural**, not a runtime branch inside the module — `worker/lib/sentry.ts`
  holds **no init and never imports `@sentry/cloudflare` at runtime** (only a `type` import). The
  `wrapRequestHandler` seam in `index.ts` is skipped when the DSN `Option` is `None`, returning
  the base fetch effect untouched, so nothing runs (`sentryDsn = Config.string("SENTRY_DSN").pipe(Config.option)`,
  `config.ts`). Absent DSN ⇒ `index.ts` adds no `SENTRY_DSN` binding ⇒ the runtime read resolves
  `None`.

The invariant is pinned by `sentry.unit.test.ts` on both tiers: the SPA test stubs the DSN
empty and re-imports the module fresh to prove `init`/`captureException` are not called
(deterministically, independent of a developer's local `.env`, #1661); the worker test proves
the module is pure options with no runtime SDK touch.

## The options idiom — `dataCollection`, not the removed `sendDefaultPii`

Both tiers build one options object with the **same shape** (only the SDK's `Options` type
differs — `Sentry.BrowserOptions` vs `CloudflareOptions`): a DSN plus a native `dataCollection`
block, and **no `beforeSend`**.

```ts
// worker/lib/sentry.ts (browserOptions in src/lib/sentry.ts is byte-identical minus the type)
export function workerOptions(dsn: string): CloudflareOptions {
	return {
		dsn,
		dataCollection: {
			userInfo: false,
			cookies: false,
			httpHeaders: {request: false, response: false},
			queryParams: false,
		},
	};
}
```

**Why `dataCollection` and not `sendDefaultPii`.** `sendDefaultPii` is **deprecated in SDK
10.62** and **removed in the next major (v11)** — `@sentry/core`'s `options.d.ts` marks it
`@deprecated Use the ClientOptions.dataCollection option instead … sendDefaultPii will be
removed in the next major version (v11)`. `dataCollection` (present since 10.57) is its granular
successor: it controls each category of collected data individually rather than one coarse
boolean. Use `dataCollection`; never re-introduce `sendDefaultPii`.

**What is sent by default vs not.** The suppression above matters because the SDK's
`dataCollection` defaults **collect** most PII (`@sentry/core` `datacollection.d.ts`):

| Field | SDK default | phoenix sets | Effect |
|---|---|---|---|
| `userInfo` | `false` | `false` | user identity never auto-populated (kept explicit) |
| `cookies` | `true` | `false` | request cookies not collected |
| `httpHeaders` | `{request: true, response: true}` | both `false` | request/response headers not collected |
| `queryParams` | `true` | `false` | URL query strings not collected |

So the suppression is real work, not a redundant restatement of defaults — three of the four
categories collect by default and are turned off here.

## The PII posture — targeted suppression, not a hand-rolled scrub (ADR 0118)

ADR 0118's decided default was "scrub PII via `beforeSend`". At implementation that resolved to
the **native `dataCollection` suppression above, with no `beforeSend`** — recorded here as the
realized shape, per the ADR's "adjustable at implementation time" clause (its US-region
amendment, #1502, makes the PII posture the load-bearing residency mitigation).

- **No blanket URL-query stripping.** Query strings carry no GDPR-PII in this app — only
  short-lived auth/OAuth tokens, caught by Sentry's **server-side default data-scrubbing by
  field name**. `queryParams: false` already stops them client-side; server-side Advanced Data
  Scrubbing is the backstop. A hand-rolled `beforeSend` that rewrites URLs is over-aggressive
  and redundant — don't add one.
- **The scrub lives in the options, not a callback.** `beforeSend` is deliberately absent
  (asserted `undefined` in both `sentry.unit.test.ts`). Suppress a category via `dataCollection`;
  reach for `beforeSend` only for a need `dataCollection` genuinely can't express.

## The worker capture seam — `wrapRequestHandler` + the effect-layer capture gap (#1502)

The worker has **no `ExportedHandler`** for `@sentry/cloudflare`'s standard `withSentry` recipe
to wrap — the fetch handler is an Effect `HttpRouter` served through alchemy (ADR 0027). So the
client is init'd at the **request boundary** in `index.ts` via `wrapRequestHandler`, the only
workerd-safe path (real client init + isolate-safe transport + flush bound to `ctx.waitUntil`).
It runs **only** when a DSN is present:

```ts
// worker/index.ts — DSN present ⇒ wrap the request HttpEffect; None ⇒ base effect verbatim
const fetch = Option.match(dsn, {
	onNone: () => baseFetch,
	onSome: (value) =>
		Effect.map(baseFetch, (httpEffect) =>
			Effect.gen(function* () {
				// captureUnhandled turns a 5xx-class Cause into an issue; see below
				const captured = captureUnhandled(httpEffect);
				const webResponse = yield* Effect.promise(() =>
					wrapRequestHandler(
						{options: workerOptions(value), request, context, captureErrors: true},
						() => Effect.runPromise(toWebResponse(request, captured).pipe(...)),
					),
				);
				return HttpServerResponse.fromWeb(webResponse);
			}),
		),
});
```

**The gap that made the first capture ship green but capture nothing (#1502).** Two SDK/runtime
facts, both grounded in source, defeat the naive wiring:

1. **`@sentry/effect` never calls `captureException`.** `SentryEffectLive` (`sentry-effect.ts`)
   is a `Tracer` + `Logger` layer only — it mirrors Effect spans to Sentry spans and routes
   `Effect.log*` to Sentry logs/breadcrumbs. It **does not create issues** from unhandled
   failures (verified: no `captureException` anywhere in `@sentry/effect`'s build). It is merged
   unconditionally (inert without a bound client — both leaves route through `@sentry/core`,
   which no-ops without `getClient()`).
2. **alchemy's `safeHttpEffect` swallows the failure before `captureErrors` can see it.**
   alchemy's `makeRequestEffect` wraps the handler in `Http.safeHttpEffect` (`Effect.catchCause`,
   error channel `never`), collapsing every failure/defect into a 499/500 `Response`. So
   `wrapRequestHandler`'s own `captureErrors: true` (default true — `@sentry/cloudflare`'s
   `request.d.ts`) never fires; it's kept only as a backstop for a thunk that still rejects.

So issue capture is wired **explicitly** at the Effect router seam, in `captureUnhandled`:

```ts
// worker/lib/sentry-capture.ts — catch the router Cause, capture + flush INLINE, return as success
export function captureUnhandled<E, R>(
	handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R> {
	return Effect.catchCause(handler, (cause) => {
		if (!shouldCaptureCause(cause)) {
			return Effect.succeed(HttpServerResponse.empty({status: 499})); // client abort — skip
		}
		return Effect.promise(async () => {
			console.error("HTTP handler failed", Cause.pretty(cause));
			for (const error of Cause.prettyErrors(cause)) captureException(error);
			await flush(2000);
			return HttpServerResponse.text("Internal Server Error", {status: 500, ...});
		});
	});
}
```

Two load-bearing shapes here, both verified against the live stage (see the rationale block in
`sentry-capture.ts`):

- **Catch-and-return-as-success, not tap-and-re-raise.** A captured event is **lost when the
  request fiber ultimately dies** (→ 500) — even with an awaited inline `flush`. So the seam
  catches the cause, captures + flushes inline, and **returns the 500 response as a success
  value**: the fiber never dies past here, so the flush lands.
- **Everything in one `Effect.promise`.** Chaining any effect *after* the flush (even an
  `Effect.logError`) loses the event. The capture, `flush`, and response all happen inside one
  awaited promise; the "handler failed" log rides on `console.error` (Workers Observability
  captures it), not a trailing `Effect.logError`.

**The capture policy** (`shouldCaptureCause`, unit-pinned): mirror `safeHttpEffect`'s
499-vs-500 split. A pure client abort (interrupt-only, e.g. an SSE disconnect) → 499 and is
**not** captured; any cause carrying a `Fail` or `Die` is a 5xx crash and **is** captured. Only
the 5xx path pays the inline-flush latency, and 5xx are rare.

## The SPA tier — the error boundary is the capture point

The browser tier is the gap CF-native Workers Observability structurally cannot see (ADR 0118).
`initSentry()` runs once in `main.tsx`; the `Screen.tsx` error boundary forwards its catch
through `captureBoundaryError(error, info.componentStack)`, attaching the React component stack
as context. Both no-op when inert. Never let an error boundary `console.error`-and-discard
without forwarding to `captureBoundaryError` — that discard is exactly the banned behavior ADR
0118 exists to end.

## Anti-patterns

- **Re-introducing `sendDefaultPii`.** It's removed in SDK v11. Use `dataCollection`; suppress
  per-category.
- **A hand-rolled `beforeSend` URL/query scrub.** `queryParams: false` + server-side field-name
  scrubbing already cover it; a blanket URL rewrite is over-aggressive and redundant (#1502).
- **Assuming `@sentry/effect` or `wrapRequestHandler`'s `captureErrors` creates issues.** They
  don't at this seam — the Effect layer only spans/breadcrumbs, and `safeHttpEffect` swallows
  the failure first. Issue capture is `captureUnhandled`'s job (#1502).
- **Tap-and-re-raise, or chaining after `flush`.** A dying fiber loses the flushed send; catch,
  capture + flush inline in one promise, and return the response as a success value.
- **Capturing a client abort.** An interrupt-only `Cause` is a 499, not a crash — `shouldCaptureCause`
  skips it; don't widen capture to it.
- **A runtime SDK import in `worker/lib/sentry.ts`.** That module is pure options (a `type`
  import only) so the worker path is structurally inert without a DSN; keep init at the
  `index.ts` seam.
- **Importing the `@sentry/effect/server` barrel broadly.** `sentry-effect.ts` imports only the
  two `@sentry/core`-clean leaves (`SentryEffectTracer`/`SentryEffectLogger`) so the bundler
  tree-shakes the workerd-hostile node-core subgraph; don't pull `init`/`effectLayer`/node-core
  symbols in.

## See also

- ADR [0118](../.decisions/0118-error-crash-monitoring-sentry-saas.md) — the *why*: Sentry SaaS,
  both tiers, the US-region amendment (#1502), the GlitchTip escape hatch, the decided defaults.
- [telemetry.md](./telemetry.md) — the sibling observability seam (product-usage AE), the same
  isolate-level-layer + `Context.Service` shape.
- [effect-layer-composition.md](./effect-layer-composition.md) — how `SentryEffectLive` merges
  into the worker layer set.
- [worker-environment-pattern.md](./worker-environment-pattern.md) — the `ENV_BINDINGS` /
  `Config` surface `SENTRY_DSN` is read through.
- [alchemy-http-router.md](./alchemy-http-router.md) — the `toHttpEffect` seam the worker
  capture wraps (why there's no `ExportedHandler`).
