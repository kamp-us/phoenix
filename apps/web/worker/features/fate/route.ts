/**
 * The `POST /fate` route (`.patterns/alchemy-http-router.md`, ADR 0029/0039).
 *
 * The worker builds ONE `ManagedRuntime` per isolate carrying the worker-level
 * services (`Drizzle` + the feature services — see `index.ts` / `layers.ts`).
 * This route is the per-request seam:
 *
 *   1. Read the raw `Request` and the execution context.
 *   2. Validate the session through the worker-level `Pasaport` (provided to the
 *      route's own context from the runtime's built context, `app.ts`).
 *   3. Build the two genuinely per-request service VALUES — `Auth` (the validated
 *      session) and `LiveBus` (the publish capability, ADR 0039) — and hand them
 *      to fate on the `FateContext` alongside the worker `runtime`. The bridge
 *      provides `auth`/`liveBus` onto EACH resolver effect and runs it on the
 *      runtime (see `effect.ts`).
 *   4. `LiveBus` closes over a per-request publisher so a mutation's `live.*`
 *      fan-out reaches the topic DO without blocking the response — `waitUntil`
 *      comes from `Cloudflare.WorkerExecutionContext`. There is no
 *      `AsyncLocalStorage` bridge (ADR 0039): the bus is a value on the
 *      `FateContext`, so a missing provide fails loudly instead of no-opping.
 *
 * Nothing is built or disposed per request: the runtime is the isolate-level one,
 * and `Auth`/`LiveBus` are plain values provided onto each resolver effect.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import type * as ManagedRuntime from "effect/ManagedRuntime";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {liveBusFor} from "../fate-live/event-bus.ts";
import {defaultLiveLimits} from "../fate-live/route.ts";
import {LiveTopics} from "../fate-live/topics.ts";
import {Pasaport} from "../pasaport/Pasaport.ts";
import type {WorkerFateServices} from "./layers.ts";
import {fateServer} from "./server.ts";

/**
 * Build the `POST /fate` handler over the isolate's worker `ManagedRuntime`.
 *
 * The runtime carries the {@link WorkerFateServices}; the handler resolves the
 * per-request session + publisher and hands fate a `FateContext` of
 * `{runtime, request, auth, liveBus}`. The bridge runs each resolver on the
 * runtime with `auth`/`liveBus` provided onto it.
 */
export const makeHandleFate = (
	runtime: ManagedRuntime.ManagedRuntime<WorkerFateServices, never>,
) =>
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

		// Hand fate the `FateContext`: the isolate runtime plus the two per-request
		// service VALUES. The bridge provides `auth`/`liveBus` onto each resolver
		// effect (it never reads them off a captured context), so they are passed as
		// values here — not provided onto this route effect.
		const res = yield* Effect.promise(() =>
			fateServer.handleRequest(raw, {
				runtime,
				request: raw,
				auth: {user: session?.user, session: session?.session},
				liveBus: liveBusFor(publisher),
			}),
		);

		return HttpServerResponse.fromWeb(res);
	});

/**
 * The `/fate` route as a router layer, ready to merge into `AppLive`. Built from
 * the isolate's worker `ManagedRuntime` in `app.ts`.
 */
export const makeFateRoute = (
	runtime: ManagedRuntime.ManagedRuntime<WorkerFateServices, never>,
) => HttpRouter.add("POST", "/fate", makeHandleFate(runtime));
