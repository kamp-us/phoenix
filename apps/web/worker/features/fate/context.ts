import type * as Context from "effect/Context";
import type {FateEnv} from "./layers.ts";

/**
 * The per-request context fate hands to every resolver and source executor as
 * `ctx`.
 *
 * Per ADR 0029 it carries a captured `Context.Context<FateEnv>` (effect v4's
 * service map — the `ServiceMap` the patterns name), **not** a `ManagedRuntime`.
 * Worker init builds the worker-level services once (`Drizzle` + features); the
 * `/fate` route provides `Auth` per request and picks up the upstream
 * `HttpServerRequest` Tag the alchemy/HttpRouter runtime already provides
 * (replacing the hand-rolled `RequestContext`), then captures the live map with
 * `Effect.context<FateEnv>()` and hands it here. The bridge runs each resolver
 * with `Effect.runPromiseExit(Effect.provide(effect, ctx.context))` — nothing is
 * built or disposed per request.
 *
 * Session is **not** a field here. It's provided into the captured context's
 * `Auth` service when the route runs, so resolvers read the caller with
 * `yield* Auth.required` rather than off the context.
 *
 * See `.patterns/alchemy-runtime.md` and `.patterns/fate-effect-bridge.md`.
 */
export interface FateContext {
	readonly context: Context.Context<FateEnv>;
	readonly request: Request;
}
