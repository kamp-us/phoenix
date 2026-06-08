/**
 * `runFateOp` — drive one fate operation through the bridge the way the `/fate`
 * route does, on a single worker-level `ManagedRuntime` (ADR 0041, supersedes
 * 0040/0029).
 *
 * This is the extraction of the per-file `fateOp` helper the bridge suites
 * (`bridge-sozluk.test.ts`, `bridge-products.test.ts`) each copy-pasted. It is
 * the test mirror of `route.ts`'s `makeHandleFate`:
 *
 *   1. builds the fate request envelope from the operation,
 *   2. builds ONE worker-level `ManagedRuntime` from the caller's worker layer
 *      (`ManagedRuntime.make(workerLayer)`) — the single runtime-build boundary,
 *      so the whole program runs through one shared layer-memo map (a second
 *      `Effect.provide`/runtime build would trip the `multipleEffectProvide`
 *      lint),
 *   3. owns the capturing `LiveBus` VALUE internally (`liveBusFor` over a capture
 *      array, ADR 0039) — it records the RESOLVED topic keys each mutation's
 *      `live.*` fans out to (run through the real `topicsForPublish`),
 *   4. hands fate a {@link FateContext} of `{runtime, request, auth, liveBus}` as
 *      `adapterContext`; the bridge (`effect.ts`) provides `auth`/`liveBus` onto
 *      each resolver effect and runs it on `runtime` — no captured `Context`, no
 *      per-request layer build,
 *   5. returns `{status, result, published}` — `published` being the resolved
 *      topic keys the operation's `live.*` fanned out to.
 *
 * The caller supplies a fully-resolved worker layer (`Layer<WorkerFateServices>`)
 * — typically `makeFateLayer` over a stable shared `Database` handle
 * (`Layer.succeed(Database)(sqlite.d1)`) + a `BetterAuth` layer, with the handle
 * rebuilt per `it` in `beforeEach`/`afterEach`, so each case runs against its own
 * in-memory D1 (no row leakage; the `it.layer`/`describe`-once form is avoided).
 */
import {ManagedRuntime} from "effect";
import type * as Layer from "effect/Layer";
import {liveBusFor} from "../fate-live/event-bus.ts";
import type {Auth} from "../pasaport/Auth.ts";
import type {FateContext} from "./context.ts";
import type {WorkerFateServices} from "./layers.ts";
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
 *   already discharged) — wrapped in a worker-level `ManagedRuntime` here; the
 *   per-request `Auth` + capturing `LiveBus` ride on the `FateContext`.
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

	// The ONE worker-level runtime for this op (ADR 0041): it carries the
	// WorkerFateServices the way `index.ts` builds the isolate runtime. This is the
	// single runtime-build / `provide` boundary — the bridge runs each resolver on
	// it via `ctx.runtime.runPromiseExit`, so there is no second `Effect.provide`
	// (which would trip the `multipleEffectProvide` lint).
	const runtime = ManagedRuntime.make(workerLayer);

	// Own the capturing `LiveBus` VALUE (ADR 0039) here — the per-request form the
	// route provides (`liveBusFor`), NOT the `Layer` form. It records the RESOLVED
	// topic keys each mutation's `live.*` fans out to (run through the real
	// `topicsForPublish`), so the caller can assert which topics a write published
	// to.
	const published: Array<string> = [];
	const liveBus = liveBusFor((topicKey) => {
		published.push(topicKey);
	});

	// Hand fate a `FateContext` of `{runtime, request, auth, liveBus}` as
	// `adapterContext` — the same shape `route.ts` builds. The bridge provides
	// `auth`/`liveBus` onto each resolver effect and runs it on `runtime`.
	const ctx: FateContext = {
		runtime,
		request,
		auth: {user: opts.auth as never, session: undefined} satisfies typeof Auth.Service,
		liveBus,
	};

	const res = await fateServer.handleRequest(request, ctx);
	const body = (await res.json()) as {version: number; results: FateResult[]};
	const [result] = body.results;
	if (result === undefined) {
		throw new Error(`fate response carried no result: ${JSON.stringify(body)}`);
	}
	return {status: res.status, result, published};
}
