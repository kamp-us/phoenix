/**
 * `runFateOp` — drive one fate operation through the fate-effect server the
 * way the `/fate` route does: `FateServer.layer(fateConfig)` over the caller's
 * worker layer, one per-op `ManagedRuntime`, `FateExecutor.toFetchHandler`
 * (ADR 0041's mechanism, the harness lifecycle).
 *
 * The test mirror of `route.ts`'s `makeHandleFate`:
 *
 *   1. builds the fate request envelope from the operation,
 *   2. builds a `ManagedRuntime` for THIS operation from
 *      `FateServer.layer(fateConfig)` provided-merged over the caller's worker
 *      layer (the same composition shape as `PhoenixFateLive`, through the same
 *      `makeFateRuntime` construction point `index.ts` uses) and DISPOSES it
 *      after the round-trip. Production's never-dispose deviation (no CF
 *      shutdown hook) does not transfer here: the Node harness HAS a shutdown
 *      point, so each runtime's scope is released when its op completes instead
 *      of leaking for the suite's lifetime. The trade-off: every op runs cold —
 *      cross-request layer memoization is a production property this harness
 *      does not exercise,
 *   3. owns the per-request publish capture internally — the recording
 *      `LivePublisher` value (`livePublisherFor` over a capturing publish +
 *      a collecting `waitUntil`, flushed before returning) records the
 *      RESOLVED topic keys a mutation's `live.*` fans out to (run through the
 *      real `topicsForPublish` frame builder),
 *   4. hands `FateExecutor.toFetchHandler(runtime)`'s handler ONE
 *      {@link FateRequestContext} — the per-request pair (`currentUser`,
 *      `livePublisher`) plus the request's `signal`, exactly the route's
 *      shape,
 *   5. returns `{status, result, published}` — `published` being the resolved
 *      topic keys the operation's `live.*` fanned out to.
 *
 * The caller supplies a fully-resolved worker layer (`Layer<WorkerFateServices>`)
 * — typically `makeFateLayer` over a stable shared `Database` handle
 * (`Layer.succeed(Database)(sqlite.d1)`) + a `BetterAuth` layer, with the handle
 * rebuilt per `it` in `beforeEach`/`afterEach`, so each case runs against its own
 * in-memory D1 (no row leakage; the `it.layer`/`describe`-once form is avoided).
 */
import {FateExecutor, type FateRequestContext, FateServer} from "@phoenix/fate-effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {livePublisherFor} from "../fate-live/live-publisher.ts";
import {fateConfig} from "./config.ts";
import {makeFateRuntime, type WorkerFateServices} from "./layers.ts";

/** A single fate operation result as it appears on the wire. */
export type FateResult =
	| {ok: true; data: unknown; id: string}
	| {ok: false; error: {code: string; message?: string}; id: string};

/** What one operation round-trip returns: HTTP status, the result, captured publishes. */
export interface FateOpResult {
	readonly status: number;
	readonly result: FateResult;
	readonly published: ReadonlyArray<string>;
}

/** A logged-in user for the per-request session; omit for anonymous. */
export interface FateOpAuth {
	readonly id: string;
	readonly name: string;
	readonly email: string;
}

/**
 * Run `operation` against `workerLayer` through the compiled fate-effect
 * server's `handleRequest`.
 *
 * @param workerLayer a fully-resolved worker layer (`Database`/`BetterAuth`
 *   already discharged) — `FateServer.layer(fateConfig)` is provided over it
 *   and the whole thing wrapped in a per-op `ManagedRuntime` here; the
 *   per-request pair rides on the one context object.
 * @param operation the fate operation body (`kind`/`name`/`args`/`input`/`select`).
 * @param opts.auth the session to provide (anonymous by default).
 */
export async function runFateOp(
	workerLayer: Layer.Layer<WorkerFateServices>,
	operation: Record<string, unknown>,
	opts: {auth?: FateOpAuth} = {},
): Promise<FateOpResult> {
	const request = new Request("https://test.local/fate", {
		method: "POST",
		headers: {"content-type": "application/json"},
		body: JSON.stringify({version: 1, operations: [{id: "1", ...operation}]}),
	});

	// The runtime for THIS op: the same `FateServer.layer(fateConfig)` +
	// domain-layers composition as production's `PhoenixFateLive`, but over the
	// caller's worker layer, built through the same `makeFateRuntime` the
	// deployed worker (`index.ts`) uses. This is the single runtime-build /
	// `provide` boundary — `toFetchHandler` resolves the `FateServer` service
	// from it and runs every resolver through it, so there is no second
	// `Effect.provide` (which would trip the `multipleEffectProvide` lint).
	// Disposed in the `finally` below — see the header on why the production
	// never-dispose deviation does not apply to this Node harness.
	const {runtime} = makeFateRuntime(
		FateServer.layer(fateConfig).pipe(Layer.provideMerge(workerLayer)),
	);
	const handleFate = FateExecutor.toFetchHandler(runtime);

	// The publish capture records RESOLVED topic keys (run through the real
	// frame/topic builders), so a suite asserts the exact keys a mutation's
	// `live.*` fanned out to.
	const published: Array<string> = [];

	// The recording `LivePublisher` VALUE: capturing publish, collecting
	// `waitUntil` (a Node harness has no execution context; the scheduled
	// promises are flushed before this op reports).
	const scheduled: Array<Promise<unknown>> = [];
	const livePublisher = livePublisherFor({
		publish: (topicKey) =>
			Effect.sync(() => {
				published.push(topicKey);
			}),
		waitUntil: (promise) => {
			scheduled.push(promise);
		},
	});

	// ONE context object, the route's exact shape: the per-request pair plus
	// the request's abort signal.
	const ctx: FateRequestContext = {
		currentUser: {user: opts.auth},
		livePublisher,
		signal: request.signal,
	};

	try {
		const res = await handleFate(request, ctx);
		const body = (await res.json()) as {version: number; results: FateResult[]};
		const [result] = body.results;
		if (result === undefined) {
			throw new Error(`fate response carried no result: ${JSON.stringify(body)}`);
		}
		// Flush the detached publishes the recording publisher handed to
		// `waitUntil` so `published` is complete when the caller reads it.
		await Promise.all(scheduled);
		return {status: res.status, result, published};
	} finally {
		// Release the runtime's scope once the op (including body read) completes —
		// no harness-built runtime outlives its operation.
		await runtime.dispose();
	}
}
