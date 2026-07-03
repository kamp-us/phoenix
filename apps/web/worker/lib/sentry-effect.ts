/**
 * The Sentry Effect Tracer + Logger as an isolate-level layer (ADR 0029, ADR 0118,
 * issue #1502). Captures typed failures AND `Cause` defects as Sentry spans/events —
 * the surface plain exception capture (the `wrapRequestHandler` seam in `index.ts`)
 * does not see. Inert until a client is bound: both leaves route through `@sentry/core`,
 * which no-ops without `getClient()`, so nothing is sent until the DSN path installs
 * the client — correct, per ADR 0118.
 *
 * Import surface is deliberately the two clean, `@sentry/core`-only leaves — NOT
 * `init`, `effectLayer`, or any `@sentry/node-core` symbol — so the bundler can
 * tree-shake the workerd-hostile node-core subgraph the `@sentry/effect/server` barrel
 * also re-exports (`export *`, `sideEffects: false`). Kept in its own module so this
 * surface stays auditable. Bundle proof is deploy-time (ADR 0118 impl).
 */
import {SentryEffectLogger, SentryEffectTracer} from "@sentry/effect/server";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Tracer from "effect/Tracer";

export const SentryEffectLive = Layer.mergeAll(
	Layer.succeed(Tracer.Tracer, SentryEffectTracer),
	// `mergeWithExisting` keeps the default (CF console) logger, so Workers
	// Observability logging continues — Sentry is additive, not a replacement (ADR 0118).
	Logger.layer([SentryEffectLogger], {mergeWithExisting: true}),
);
