/**
 * `runFateOp` — drive one fate operation through the bridge the way the `/fate`
 * route does, in a single `Effect.provide` (ADR 0040).
 *
 * This is the extraction of the per-file `fateOp` helper the bridge suites
 * (`bridge-sozluk.test.ts`, `bridge-products.test.ts`) each copy-pasted. It:
 *
 *   1. builds the fate request envelope from the operation,
 *   2. owns the capturing `LiveBus` stub internally (`makeLiveBusForTest`) so the
 *      whole program is provided in **exactly one** `Effect.provide` — chaining a
 *      second `Effect.provide` would trip the `multipleEffectProvide` lint, and a
 *      shared layer-memo map across the request handler + every service is what
 *      the single-provide contract guarantees,
 *   3. captures the live `FateEnv` `Context` with `Effect.context<FateEnv>()` and
 *      hands it to `fateServer.handleRequest` through `{context, request}`,
 *   4. returns `{status, result, published}` — `published` being the resolved
 *      topic keys the operation's `live.*` fanned out to.
 *
 * The caller supplies a fully-resolved worker layer (`Layer<WorkerFateServices>`)
 * — typically `makeFateLayer` over a stable shared `Database` handle
 * (`Layer.succeed(Database)(sqlite.d1)`) + a `BetterAuth` layer, with the handle
 * rebuilt per `it` in `beforeEach`/`afterEach`, so each case runs against its own
 * in-memory D1 (no row leakage; the `it.layer`/`describe`-once form is avoided).
 */
import {Effect, Layer} from "effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import {makeLiveBusForTest} from "../fate-live/event-bus.ts";
import {Auth} from "../pasaport/Auth.ts";
import type {FateEnv, WorkerFateServices} from "./layers.ts";
import {fateServer} from "./server.ts";

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

/** A logged-in user for the per-request `Auth`; omit for anonymous. */
export interface FateOpAuth {
	readonly id: string;
	readonly name: string;
	readonly email: string;
}

/**
 * Run `operation` against `workerLayer` through `fateServer.handleRequest`.
 *
 * @param workerLayer a fully-resolved worker layer (`Database`/`BetterAuth`
 *   already discharged) — the per-request `Auth` + `HttpServerRequest` + the
 *   capturing `LiveBus` are layered on internally.
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

	// Own the capturing `LiveBus` (ADR 0039) here: it records the RESOLVED topic
	// keys each mutation's `live.*` fans out to (run through the real
	// `topicsForPublish`), so the caller can assert which topics a write published
	// to. Constructing it inside keeps the single-`provide` contract — see below.
	const {layer: LiveBusTest, published} = makeLiveBusForTest();

	const captureAndServe = Effect.gen(function* () {
		// The captured map carries the worker-level services PLUS the per-request
		// Auth/HttpServerRequest provided just below — the full FateEnv.
		const context = yield* Effect.context<FateEnv>();
		return yield* Effect.promise(() => fateServer.handleRequest(request, {request, context}));
	}).pipe(
		Effect.provideService(Auth, {user: opts.auth as never, session: undefined}),
		Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request)),
		// EXACTLY ONE `Effect.provide` (the capturing `LiveBus` + the worker-level
		// services merged): the fate request handler and every service share one
		// layer-memo map, and a second `Effect.provide` would trip the
		// `multipleEffectProvide` lint.
		Effect.provide(Layer.mergeAll(LiveBusTest, workerLayer)),
	);

	const res = await Effect.runPromise(captureAndServe);
	const body = (await res.json()) as {version: number; results: FateResult[]};
	const [result] = body.results;
	if (result === undefined) {
		throw new Error(`fate response carried no result: ${JSON.stringify(body)}`);
	}
	return {status: res.status, result, published};
}
