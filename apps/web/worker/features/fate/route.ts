/**
 * The `POST /fate` route (ADR 0041, supersedes 0029; `.patterns/alchemy-http-router.md`).
 *
 * The worker builds the isolate-level `ManagedRuntime` ({@link WorkerRuntime}) in
 * init (`index.ts`) and hands it to this route as a value (mechanism — how the
 * bridge runs resolvers through it: see the `effect.ts` header + ADR 0041).
 * This route is the per-request seam:
 *
 *   1. Read the raw `Request` (`Cloudflare.Request`) and the execution context.
 *   2. Validate the session through the worker-level `Pasaport` — no throwaway
 *      runtime (this replaces the old `validateSessionCookie`).
 *   3. Build the two genuinely per-request services as VALUES — `Auth` (the
 *      validated session) and `LiveBus` (the publish capability, ADR 0039) — and
 *      hand fate a {@link FateContext} of `{runtime, request, auth, liveBus}` as
 *      `adapterContext`.
 *   4. `LiveBus` closes over a per-request publisher so a mutation's `live.*`
 *      fan-out reaches the topic DO without blocking the response — `waitUntil`
 *      comes from `Cloudflare.WorkerExecutionContext` (ADR 0029), not a disposed
 *      runtime. There is no `AsyncLocalStorage` bridge (ADR 0039): the bus rides
 *      the `FateContext` like `Auth`, so a missing value is a type error, not a
 *      silent no-op.
 *
 * Because the runtime is a constructor argument (`makeHandleFate(runtime)`), the
 * route holds no module-level runtime — `index.ts` is the single construction +
 * ownership point (the runtime is never disposed; CF isolates have no shutdown
 * hook — see ADR 0041).
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {liveBusFor} from "../fate-live/event-bus.ts";
import {defaultLiveLimits} from "../fate-live/route.ts";
import {LiveTopics} from "../fate-live/topics.ts";
import {Pasaport} from "../pasaport/Pasaport.ts";
import type {FateContext} from "./context.ts";
import type {WorkerRuntime} from "./layers.ts";
import {fateServer} from "./server.ts";

/**
 * Build the `POST /fate` handler over the isolate's worker {@link WorkerRuntime}.
 * Resolves the session through the worker-level `Pasaport`, builds the per-request
 * `Auth` + `LiveBus` VALUES, and hands fate a `FateContext` of
 * `{runtime, request, auth, liveBus}` — the bridge runs each resolver on the
 * runtime with those two services provided onto the effect.
 */
export const makeHandleFate = (runtime: WorkerRuntime) =>
	Effect.gen(function* () {
		const raw = yield* Cloudflare.Request;
		const executionCtx = yield* Cloudflare.WorkerExecutionContext;
		const pasaport = yield* Pasaport;
		const liveTopics = yield* LiveTopics;

		const session = yield* pasaport.validateSession(raw.headers);

		// The per-request live publisher (ADR 0028/0029/0039): a mutation's synchronous
		// `live.*` call resolves topic keys and fires the typed `TopicDO.publish` RPC
		// here. The topic namespace is worker-init-resolved (carried by `LiveTopics`,
		// no `env` lookup, no `idFromName`, no string-URL `stub.fetch`); `waitUntil`
		// comes from `Cloudflare.WorkerExecutionContext` so the best-effort fan-out
		// doesn't block the response. A failed publish is swallowed loudly — the
		// mutation response already succeeded.
		const publisher = (topicKey: string, message: Parameters<typeof liveTopics.publish>[1]) => {
			executionCtx.waitUntil(
				// Deliberate Effect→Promise boundary: this fire-and-forget publish is
				// handed to `waitUntil` (a Promise sink) outside the request fiber.
				// `liveTopics.publish` is self-contained (R = never), so it needs no
				// surrounding services — `runPromise` is correct, not `runPromiseWith`.
				// @effect-diagnostics-next-line effect/runEffectInsideEffect:off
				Effect.runPromise(liveTopics.publish(topicKey, message, defaultLiveLimits)).catch(
					(error: unknown) => {
						console.error(`live publish to topic:${topicKey} failed`, error);
					},
				),
			);
		};

		// Hand fate a `FateContext` of `{runtime, request, auth, liveBus}` as
		// `adapterContext`. The bridge (`effect.ts`) provides `auth`/`liveBus` onto
		// each resolver effect and runs it on `runtime` — no per-request layer build,
		// no `Effect.context<FateEnv>()` capture.
		const ctx: FateContext = {
			runtime,
			request: raw,
			auth: {user: session?.user, session: session?.session},
			liveBus: liveBusFor(publisher),
		};

		const res = yield* Effect.promise(() => fateServer.handleRequest(raw, ctx));

		return HttpServerResponse.fromWeb(res);
	});

/**
 * Build the `/fate` route as a router layer over the isolate's worker runtime,
 * ready to merge into `AppLive`. Called once in `index.ts` / `makeAppLive` with
 * the single per-isolate {@link WorkerRuntime}.
 */
export const makeFateRoute = (runtime: WorkerRuntime) =>
	HttpRouter.add("POST", "/fate", makeHandleFate(runtime));
