/**
 * The `POST /fate` route (ADR 0043; `.patterns/alchemy-http-router.md`,
 * `.patterns/fate-effect-interpreter.md`).
 *
 * Since the v2 cutover the route serves through the NATIVE interpreter:
 * `FateInterpreter.handleRequest(raw, ctx)` is an Effect, yielded on this
 * route's own request fiber — there is no per-request `ManagedRuntime` and
 * no Effect→Promise hop on the request path. The worker init still builds
 * the one isolate-level runtime (`makeFateRuntime`, `index.ts`), but only as
 * the layer-build vehicle: the `FateServer` service (and the worker
 * singletons) reach this route through the runtime-derived context layer via
 * `HttpRouter.provideRequest` (`http/app.ts`).
 *
 * Per request:
 *
 *   1. Read the raw `Request` (`Cloudflare.Request`) and the execution context.
 *   2. Validate the session through the worker-level `Pasaport`.
 *   3. Build the per-request {@link FateRequestContext}: `currentUser` (the
 *      session user; `CurrentUserInfo` is a structural subset of the
 *      better-auth user) and `livePublisher` (`livePublisherFor` over the
 *      worker-init `LiveTopics` publish + the request's `waitUntil`).
 *   4. Yield the interpreter program wrapped in {@link interruptOnAbort}:
 *      alchemy's worker bridge runs the request fiber without abort wiring
 *      (`Effect.runPromiseExit`, no signal), so the route edge owns it —
 *      the same mechanism effect-smol's own platform handler uses
 *      (`HttpEffect.toWebHandlerWith`: listen on `request.signal`, interrupt
 *      the fiber). A disconnected client interrupts the resolver fibers.
 *
 * Because the program runs on the request fiber, every handler/source
 * `Effect.fn` span nests under the router's request span (the
 * `HttpEffect.toHandled` tracer middleware) — observability holds with no
 * explicit runtime (pinned package-side in `Interpreter.batch.test.ts`).
 *
 * The publisher rides the worker-init `LiveTopics` + per-request `waitUntil`
 * (ADR 0028/0029/0039): a mutation's `live.*` fan-out reaches the topic DO
 * without blocking the response, and a failed publish is swallowed loudly —
 * the mutation response already succeeded.
 */
import {FateInterpreter, type FateRequestContext} from "@phoenix/fate-effect";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {interruptOnAbort} from "../../http/interrupt-on-abort.ts";
import {livePublisherFor} from "../fate-live/live-publisher.ts";
import {defaultLiveLimits, type PublishMessage} from "../fate-live/protocol.ts";
import {LiveTopics} from "../fate-live/topics.ts";
import {Pasaport} from "../pasaport/Pasaport.ts";

/**
 * The `POST /fate` handler: resolve the session, build the one
 * {@link FateRequestContext}, and serve through the native interpreter on
 * this request fiber. Requires `FateServer` (discharged by the
 * runtime-derived context layer in `http/app.ts`) alongside the other
 * worker services.
 */
export const handleFate = Effect.gen(function* () {
	const raw = yield* Cloudflare.Request;
	const executionCtx = yield* Cloudflare.WorkerExecutionContext;
	const pasaport = yield* Pasaport;
	const liveTopics = yield* LiveTopics;

	const session = yield* pasaport.validateSession(raw.headers);

	// The per-request live publish capability (ADR 0028/0029/0039): one
	// worker-init-resolved `LiveTopics` (typed `TopicDO.publish` RPC — no
	// `env` lookup, no `idFromName`, no string-URL `stub.fetch`) with the
	// route's `LiveLimits` applied, one `waitUntil` from
	// `Cloudflare.WorkerExecutionContext` so the best-effort fan-out doesn't
	// block the response.
	const publishToTopic = (topicKey: string, message: PublishMessage) =>
		liveTopics.publish(topicKey, message, defaultLiveLimits);
	const waitUntil = (promise: Promise<unknown>) => {
		executionCtx.waitUntil(promise);
	};

	// ONE context object for the whole request: the interpreter provides the
	// pair as VALUES off this object to every operation — never copy or
	// rebuild it per resolver. No `signal` field: interruption is wired at
	// this edge (below), not inside the interpreter.
	const ctx: FateRequestContext = {
		currentUser: {user: session?.user},
		livePublisher: livePublisherFor({publish: publishToTopic, waitUntil}),
	};

	const res = yield* FateInterpreter.handleRequest(raw, ctx).pipe(interruptOnAbort(raw.signal));

	return HttpServerResponse.fromWeb(res);
});

/**
 * The `/fate` route layer, ready to merge into `AppLive` (`http/app.ts`).
 * Its handler requirements — `FateServer` + the worker services — are
 * discharged per request by `HttpRouter.provideRequest` over the
 * runtime-derived context layer.
 */
export const fateRoute = HttpRouter.add("POST", "/fate", handleFate);
