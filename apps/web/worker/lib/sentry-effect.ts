/**
 * The Sentry Effect Tracer + Logger as an isolate-level layer (ADR 0029/0118, #1502).
 * Captures typed failures AND `Cause` defects — the surface plain exception capture
 * does not see. Inert until a client is bound: both leaves no-op without `getClient()`.
 *
 * The import surface is deliberately the two `@sentry/core`-only leaves — NOT `init`,
 * `effectLayer`, or any `@sentry/node-core` symbol — so the bundler can tree-shake the
 * workerd-hostile node-core subgraph the `@sentry/effect/server` barrel re-exports.
 * Kept in its own module so that surface stays auditable.
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
