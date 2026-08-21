/**
 * The `POST /fate` route. Since the v2 cutover (ADR 0043) it serves through the native
 * interpreter on its own request fiber — no per-request runtime, no Effect→Promise hop.
 * See `.patterns/fate-effect-interpreter.md`.
 *
 * The route edge owns abort→interruption ({@link interruptOnAbort}): alchemy's worker
 * bridge runs the request fiber without abort wiring, so a disconnected client would
 * not interrupt the resolver fibers unless the edge wires it.
 */
import type {CurrentActor} from "@kampus/authz";
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
import {
	makeSandboxViewerMemo,
	SandboxViewerMemo,
	type SandboxViewerResolution,
} from "../kunye/sandbox.ts";
import {PanoFeedCache, panoFeedCacheFor} from "../pano/feed-cache.ts";
import {Pasaport} from "../pasaport/Pasaport.ts";

/**
 * ONE context object for the whole request — never copied or rebuilt per resolver. It
 * fulfills the per-request services registered in `layers.ts` (ADR 0107 §7).
 *
 * Exported so its membership is pinned by a test rather than by reading this file:
 * {@link SandboxViewerMemo} is a `Context.Reference`, so dropping it from here would not
 * break a type or a run — every read would just quietly go back to resolving per call
 * site (#6457).
 */
export const requestServicesFor = (parts: {
	readonly actor: Context.Context<CurrentActor>;
	readonly flagOverrides: typeof RequestFlagOverrides.Service;
	readonly feedCache: typeof PanoFeedCache.Service;
	readonly sandboxViewer: SandboxViewerResolution;
}): Context.Context<CurrentActor | PanoFeedCache | RequestFlagOverrides> =>
	Context.merge(
		parts.actor,
		Context.merge(
			Context.make(RequestFlagOverrides, parts.flagOverrides),
			Context.merge(
				Context.make(PanoFeedCache, parts.feedCache),
				Context.make(SandboxViewerMemo, parts.sandboxViewer),
			),
		),
	);

export const handleFate = Effect.gen(function* () {
	const raw = yield* Cloudflare.Request;
	const executionCtx = yield* Cloudflare.WorkerExecutionContext;
	const pasaport = yield* Pasaport;
	const liveTopics = yield* LiveTopics;

	const session = yield* pasaport.validateSession(raw.headers);

	// `waitUntil` keeps the best-effort live fan-out from blocking the response (ADR 0039).
	const publishToTopic = (topicKey: string, message: PublishMessage) =>
		liveTopics.publish(topicKey, message, defaultLiveLimits);
	const waitUntil = (promise: Promise<unknown>) => {
		executionCtx.waitUntil(promise);
	};

	// `ctx.cache.purge` is the worker's OWN scoped purge capability (no zone purge, no API
	// token); it is absent offline / in dev (`cache?`), where the purge degrades to a no-op.
	const flagsContext = yield* makeRequestFlagsContext(
		anonymousFlagsContext,
		raw.headers.get("cookie"),
	);
	const feedCache = panoFeedCacheFor({
		purge: (options) => executionCtx.cache?.purge(options) ?? Promise.resolve(),
		waitUntil,
	});

	// May this request honor its `phoenix_flag_overrides` cookie (#2741)? Resolved ONCE at
	// the edge, then threaded — the admin verdict cannot be recomputed per resolver.
	const overridesAllowed = yield* overridesAuthorized(flagsContext).pipe(
		Effect.provide(currentActorContext(session?.user)),
	);

	// The sandbox viewer costs up to three reads and is asked for at 26 resolver sites, so
	// it resolves once per request instead of once per site (#6457). Lazy: nothing is read
	// until the first site asks, and a request touching none reads nothing.
	const sandboxViewer = yield* makeSandboxViewerMemo;

	const requestServices = requestServicesFor({
		actor: currentActorContext(session?.user),
		flagOverrides: {cookieHeader: raw.headers.get("cookie"), overridesAllowed},
		feedCache,
		sandboxViewer,
	});
	const ctx: FateRequestContext = {
		currentUser: {user: session?.user},
		livePublisher: livePublisherFor({publish: publishToTopic, waitUntil}),
		requestServices,
	};

	const res = yield* FateInterpreter.handleRequest(raw, ctx).pipe(interruptOnAbort(raw.signal));

	return HttpServerResponse.fromWeb(res);
});

export const fateRoute = HttpRouter.add("POST", "/fate", handleFate);
