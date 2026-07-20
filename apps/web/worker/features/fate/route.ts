/**
 * The `POST /fate` route. Since the v2 cutover (ADR 0043) it serves through the
 * native interpreter on its own request fiber — no per-request runtime, no
 * Effect→Promise hop. The `FateServer` service and worker singletons reach the
 * handler through the runtime-derived context layer (`HttpRouter.provideRequest`,
 * `http/app.ts`). See `.patterns/alchemy-http-router.md`,
 * `.patterns/fate-effect-interpreter.md`.
 *
 * The route edge owns abort→interruption ({@link interruptOnAbort}): alchemy's
 * worker bridge runs the request fiber without abort wiring, so a disconnected
 * client wouldn't interrupt the resolver fibers unless the edge wires it.
 */
import {FateInterpreter, type FateRequestContext} from "@kampus/fate-effect";
import * as Cloudflare from "alchemy/Cloudflare";
import {Context} from "effect";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {interruptOnAbort} from "../../http/interrupt-on-abort.ts";
import {livePublisherFor} from "../fate-live/live-publisher.ts";
import {defaultLiveLimits, type PublishMessage} from "../fate-live/protocol.ts";
import {LiveTopics} from "../fate-live/topics.ts";
import {
	anonymousFlagsContext,
	makeRequestFlagsContext,
	RequestFlagOverrides,
} from "../flagship/FlagsContext.ts";
import {overridesAuthorized} from "../flagship/override-authz.ts";
import {currentActorContext} from "../kunye/CurrentActorLive.ts";
import {PanoFeedCache, panoFeedCacheFor} from "../pano/feed-cache.ts";
import {Pasaport} from "../pasaport/Pasaport.ts";

export const handleFate = Effect.gen(function* () {
	const raw = yield* Cloudflare.Request;
	const executionCtx = yield* Cloudflare.WorkerExecutionContext;
	const pasaport = yield* Pasaport;
	const liveTopics = yield* LiveTopics;

	const session = yield* pasaport.validateSession(raw.headers);

	// `waitUntil` keeps the best-effort live fan-out from blocking the response
	// (ADR 0028/0029/0039).
	const publishToTopic = (topicKey: string, message: PublishMessage) =>
		liveTopics.publish(topicKey, message, defaultLiveLimits);
	const waitUntil = (promise: Promise<unknown>) => {
		executionCtx.waitUntil(promise);
	};

	// The base-feed edge-cache purger a fanned pano mutation fires alongside its live
	// publish (ADR 0170 / #2324). `ctx.cache.purge` is the worker's OWN scoped purge
	// capability (no zone purge, no API token); it is absent offline / in dev (`cache?`),
	// where the purge degrades to a no-op.
	const flagsContext = yield* makeRequestFlagsContext(
		anonymousFlagsContext,
		raw.headers.get("cookie"),
	);
	const feedCache = panoFeedCacheFor({
		purge: (options) => executionCtx.cache?.purge(options) ?? Promise.resolve(),
		waitUntil,
	});

	// May this request honor its `phoenix_flag_overrides` cookie (#2741)? Resolved ONCE
	// at the edge (dev, or an admin) over the request's actor, then threaded on
	// `RequestFlagOverrides` so `provideRequestFlags` gates every resolver's flag read off
	// it — the admin verdict can't be recomputed per resolver.
	const overridesAllowed = yield* overridesAuthorized(flagsContext).pipe(
		Effect.provide(currentActorContext(session?.user)),
	);

	// ONE context object for the whole request — never copy or rebuild it per
	// resolver. No `signal` field: interruption is wired at this edge (below).
	// `requestServices` fulfills the `[CurrentActor, RequestFlagOverrides]`
	// registered in `layers.ts`: `CurrentActor` derived from the validated session
	// (ADR 0107 §7), `RequestFlagOverrides` carrying the raw `Cookie` header + the
	// `overridesAllowed` verdict so a flag-gated resolver's `provideRequestFlags` can
	// source the #622 cookie only when authorized (dev, or admin + flag; #2741).
	const requestServices = Context.merge(
		currentActorContext(session?.user),
		Context.merge(
			Context.make(RequestFlagOverrides, {
				cookieHeader: raw.headers.get("cookie"),
				overridesAllowed,
			}),
			Context.make(PanoFeedCache, feedCache),
		),
	);
	const ctx: FateRequestContext = {
		currentUser: {user: session?.user},
		livePublisher: livePublisherFor({publish: publishToTopic, waitUntil}),
		requestServices,
	};

	const res = yield* FateInterpreter.handleRequest(raw, ctx).pipe(interruptOnAbort(raw.signal));

	return HttpServerResponse.fromWeb(res);
});

export const fateRoute = HttpRouter.add("POST", "/fate", handleFate);
