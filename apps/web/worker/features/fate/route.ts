/**
 * The `POST /fate` route (ADR 0041; `.patterns/alchemy-http-router.md`,
 * `.patterns/fate-effect-compiler.md`).
 *
 * The worker builds the isolate-level `ManagedRuntime` ({@link WorkerRuntime})
 * in init (`index.ts`) — carrying the worker singletons AND the composed
 * `FateServer` service ({@link PhoenixFateLive}) — and hands it to this route
 * as a value. `FateExecutor.toFetchHandler(runtime)` resolves the service and
 * compiles the real fate server ONCE (memoized across requests); this route is
 * the per-request seam:
 *
 *   1. Read the raw `Request` (`Cloudflare.Request`) and the execution context.
 *   2. Validate the session through the worker-level `Pasaport`.
 *   3. Build ONE request-context object ({@link CoexistenceFateContext}) and
 *      hand it to the fetch handler as fate's adapterContext:
 *      - the fate-effect per-request pair as VALUES — `currentUser` (the
 *        session user; `CurrentUserInfo` is a structural subset of the
 *        better-auth user) and `livePublisher` (`livePublisherFor` over the
 *        worker-init `LiveTopics` publish + the request's `waitUntil`) — plus
 *        the abort `signal` so a disconnected client interrupts the resolver
 *        fiber;
 *      - the legacy bridge `FateContext` fields (`runtime`, `request`, `auth`,
 *        `liveBus`) on the SAME object, for the not-yet-migrated records.
 *   4. Both publishers ride the same worker-init `LiveTopics` + per-request
 *      `waitUntil` (ADR 0028/0029/0039): a mutation's `live.*` fan-out reaches
 *      the topic DO without blocking the response, and a failed publish is
 *      swallowed loudly — the mutation response already succeeded.
 *
 * Because the runtime is a constructor argument (`makeHandleFate(runtime)`),
 * the route holds no module-level runtime — `index.ts` is the single
 * construction + ownership point (the runtime is never disposed; CF isolates
 * have no shutdown hook — see ADR 0041).
 */
import {FateExecutor} from "@phoenix/fate-effect";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {liveBusFor} from "../fate-live/event-bus.ts";
import {livePublisherFor} from "../fate-live/live-publisher.ts";
import {defaultLiveLimits} from "../fate-live/route.ts";
import {LiveTopics} from "../fate-live/topics.ts";
import {Pasaport} from "../pasaport/Pasaport.ts";
import type {CoexistenceFateContext} from "./context.ts";
import type {WorkerRuntime} from "./layers.ts";

/**
 * Build the `POST /fate` handler over the isolate's worker {@link WorkerRuntime}.
 * `toFetchHandler` is bound once per route construction (the compiled server is
 * memoized inside it); per request the handler resolves the session, builds the
 * one {@link CoexistenceFateContext} object, and serves through the compiled
 * fate server.
 */
export const makeHandleFate = (runtime: WorkerRuntime) => {
	const handleFate = FateExecutor.toFetchHandler(runtime);

	return Effect.gen(function* () {
		const raw = yield* Cloudflare.Request;
		const executionCtx = yield* Cloudflare.WorkerExecutionContext;
		const pasaport = yield* Pasaport;
		const liveTopics = yield* LiveTopics;

		const session = yield* pasaport.validateSession(raw.headers);

		// The per-request live publish capability, shared by both publish surfaces
		// (ADR 0028/0029/0039): one worker-init-resolved `LiveTopics` (typed
		// `TopicDO.publish` RPC — no `env` lookup, no `idFromName`, no string-URL
		// `stub.fetch`) with the route's `LiveLimits` applied, one `waitUntil` from
		// `Cloudflare.WorkerExecutionContext` so the best-effort fan-out doesn't
		// block the response.
		const publishToTopic = (topicKey: string, message: Parameters<typeof liveTopics.publish>[1]) =>
			liveTopics.publish(topicKey, message, defaultLiveLimits);
		const waitUntil = (promise: Promise<unknown>) => {
			executionCtx.waitUntil(promise);
		};

		// The legacy bridge bus (dies with the bridge, tasks 10–13): same topic
		// publish, detached onto `waitUntil` here — `liveBusFor` takes the sync
		// fire-and-forget form. A failed publish is swallowed loudly; the mutation
		// response already succeeded.
		const publisher = (topicKey: string, message: Parameters<typeof liveTopics.publish>[1]) => {
			waitUntil(
				// Deliberate Effect→Promise boundary: this fire-and-forget publish is
				// handed to `waitUntil` (a Promise sink) outside the request fiber.
				// `liveTopics.publish` is self-contained (R = never), so it needs no
				// surrounding services — `runPromise` is correct, not `runPromiseWith`.
				// @effect-diagnostics-next-line effect/runEffectInsideEffect:off
				Effect.runPromise(publishToTopic(topicKey, message)).catch((error: unknown) => {
					console.error(`live publish to topic:${topicKey} failed`, error);
				}),
			);
		};

		// ONE context object for the whole request (identity is the coexistence
		// contract — see `CoexistenceFateContext`): the fate-effect pair + signal
		// for compiled entries, the legacy `FateContext` fields for bridge records.
		const ctx: CoexistenceFateContext = {
			currentUser: {user: session?.user},
			livePublisher: livePublisherFor({publish: publishToTopic, waitUntil}),
			signal: raw.signal,
			runtime,
			request: raw,
			auth: {user: session?.user, session: session?.session},
			liveBus: liveBusFor(publisher),
		};

		const res = yield* Effect.promise(() => handleFate(raw, ctx));

		return HttpServerResponse.fromWeb(res);
	});
};

/**
 * Build the `/fate` route as a router layer over the isolate's worker runtime,
 * ready to merge into `AppLive`. Called once in `index.ts` / `makeAppLive` with
 * the single per-isolate {@link WorkerRuntime}.
 */
export const makeFateRoute = (runtime: WorkerRuntime) =>
	HttpRouter.add("POST", "/fate", makeHandleFate(runtime));
