/**
 * `FateInterpreter` — the v2 native dispatch loop: fate's `handleRequest` as
 * an Effect program (PRD "v2 backend: the native interpreter"; tasks.md task
 * 14; ADR 0042 "What v2 changes").
 *
 * The loop is decode → run → encode, every stage byte-faithful to the v1
 * compiled server (the differential oracle in `Interpreter.test.ts` enforces
 * it):
 *
 *   1. **Decode** — the request body parses as JSON (fate's exact
 *      `BAD_REQUEST` on failure) and gates through
 *      `decodeProtocolRequest` (fate's `assertProtocolRequest` as staged
 *      Schema decodes, `Protocol.ts`).
 *   2. **Run** — operations dispatch CONCURRENTLY via `Effect.forEach` with
 *      `concurrency: "unbounded"` (effect-smol `Effect.ts` § `forEach` —
 *      the order-preserving collector; fate's own loop is `Promise.all`).
 *      Each operation runs through the ONE shared provision pipeline
 *      (`provideRequestPair`, `Provision.ts`: the per-request pair as VALUES
 *      off the request context, captured build-time services beneath) — the
 *      v1 compiler's `runResolve` minus the Promise hop: no runtime here,
 *      the program stays an Effect and the caller (the worker route's
 *      request fiber; the oracle's test runtime) owns the run.
 *   3. **Encode** — per-operation outcomes map through `encodeWireError`
 *      (the ONE annotation codec both backends share) onto the protocol
 *      error shape, and the response encodes through the canonical
 *      `ProtocolResponse` codec — field order is the schema's, which is
 *      fate's serialization order.
 *
 * Interpreter coverage: the DISPATCH plane — query, mutation, and
 * custom-list operations (phoenix has no root lists — ADR 0016/0019) — plus
 * the BYID plane (`Walk.ts`: the Effect selection walk over
 * `RequestResolver`-batched sources; the walk is constructed once per
 * request, BEFORE the dispatch loop, so its batch window spans every
 * operation in the request) and its CONNECTION plane (`Connection.ts`:
 * Schema-decoded pagination args + fate's in-array windowing for raw arrays
 * under selected list-kind fields).
 *
 * **This IS the serving path since the v2 cutover (ADR 0043)**: the worker's
 * `POST /fate` route yields `handleRequest` on the request fiber — no
 * per-request runtime, spans nest under the platform's request span, and
 * the route wires the request's abort signal to fiber interruption. The v1
 * compiled server (`Executor.ts`) remains only as the differential oracle's
 * baseline; the raw legacy config arms were removed with the cutover.
 */
import {FateRequestError} from "@nkzw/fate/server";
import {Cause, Effect, Exit, Option} from "effect";
import type {FateRequestContext} from "./Executor.ts";
import type {
	DecodedProtocolOperation,
	ProtocolNamedOperation,
	ProtocolResponse,
} from "./Protocol.ts";
import {decodeProtocolRequest, encodeProtocolResponse} from "./Protocol.ts";
import {type ProvideRequestPair, provideRequestPair} from "./Provision.ts";
import type {FateServerService} from "./Server.ts";
import {FateServer} from "./Server.ts";
import type {FateWalk} from "./Walk.ts";
import {makeWalk} from "./Walk.ts";
import {encodeWireError} from "./WireError.ts";

type OperationResultValue = (typeof ProtocolResponse)["Type"]["results"][number];

type ProtocolErrorValue = Extract<OperationResultValue, {readonly ok: false}>["error"];

/** fate's response headers, byte for byte. */
const JSON_HEADERS = {"content-type": "application/json; charset=utf-8"};

/**
 * fate's `toProtocolError`, exactly: a `FateRequestError` keeps its code,
 * issues, and message; anything else is fate's OWN internal arm (`code:
 * "INTERNAL_ERROR"` — distinct from the annotation codec's
 * `INTERNAL_SERVER_ERROR`, which only per-operation failures produce). The
 * conditional `issues` spread matches fate's `issues: error.issues` +
 * JSON.stringify dropping `undefined`.
 */
const toProtocolErrorValue = (error: unknown): ProtocolErrorValue =>
	error instanceof FateRequestError
		? {
				code: error.code,
				...(error.issues !== undefined ? {issues: error.issues} : {}),
				message: error.message,
			}
		: {code: "INTERNAL_ERROR", message: "Internal server error."};

/**
 * The failed/thrown value behind a Cause — the v1 compiler's exact branch
 * (`runResolve`): a typed failure if one exists, otherwise the squashed
 * defect.
 */
const failureOf = (cause: Cause.Cause<unknown>): unknown =>
	Option.match(Cause.findErrorOption(cause), {
		onSome: (error) => error,
		onNone: () => Cause.squash(cause),
	});

/**
 * Resolve a named operation to its entry's effect — fate's `executeOperation`
 * dispatch order and NOT_FOUND messages, against the package's config
 * records. `Object.hasOwn` guards the lookup (fate indexes the raw record and
 * would trip over prototype names like `"constructor"`; that divergence is
 * deliberate — a prototype name is NOT a registered operation).
 */
const namedOperationEffect = (
	server: FateServerService,
	operation: ProtocolNamedOperation,
): Effect.Effect<unknown, unknown, unknown> => {
	const {name} = operation;
	switch (operation.kind) {
		case "list": {
			const entry = Object.hasOwn(server.lists, name) ? server.lists[name] : undefined;
			if (entry === undefined) {
				return Effect.fail(new FateRequestError("NOT_FOUND", `No list registered for '${name}'.`));
			}
			return entry.resolve({args: operation.args, select: operation.select});
		}
		case "query": {
			const entry = Object.hasOwn(server.queries, name) ? server.queries[name] : undefined;
			if (entry === undefined) {
				return Effect.fail(new FateRequestError("NOT_FOUND", `No query registered for '${name}'.`));
			}
			return entry.resolve({args: operation.args, select: operation.select});
		}
		case "mutation": {
			const entry = Object.hasOwn(server.mutations, name) ? server.mutations[name] : undefined;
			if (entry === undefined) {
				return Effect.fail(
					new FateRequestError("NOT_FOUND", `No mutation registered for '${name}'.`),
				);
			}
			return entry.resolve({input: operation.input, select: operation.select});
		}
	}
};

/** fate's `executeOperation` preamble: byId first, then the name gate. */
const operationEffect = (
	server: FateServerService,
	walk: FateWalk,
	operation: DecodedProtocolOperation,
): Effect.Effect<unknown, unknown, unknown> => {
	if (operation.kind === "byId") {
		// The selection walk: masking, authorize gates, batched source loads.
		return walk.byId(operation);
	}
	if (operation.name === "") {
		// The protocol gate lets "" through (a string); fate rejects it here.
		return Effect.fail(
			new FateRequestError("BAD_REQUEST", `${operation.kind} operations require a name.`),
		);
	}
	return namedOperationEffect(server, operation);
};

/**
 * Run ONE operation to its wire result. Never fails: success carries the
 * handler value; any failure or defect maps through `encodeWireError` (the
 * annotation codec — the v1 path's exact taxonomy: annotated code, fixed
 * internal message for defects, `FateRequestError` passthrough) onto the
 * protocol error arm.
 */
const runOperation = (
	server: FateServerService,
	walk: FateWalk,
	provide: ProvideRequestPair,
	operation: DecodedProtocolOperation,
): Effect.Effect<OperationResultValue> =>
	provide(operationEffect(server, walk, operation)).pipe(
		Effect.exit,
		Effect.map(
			(exit): OperationResultValue =>
				Exit.isSuccess(exit)
					? {data: exit.value, id: operation.id, ok: true}
					: {
							error: toProtocolErrorValue(encodeWireError(failureOf(exit.cause))),
							id: operation.id,
							ok: false,
						},
		),
	);

/** Parse the request body — fate's `parseJSON`, message and code included. */
const parseBody = (request: Request): Effect.Effect<unknown, FateRequestError> =>
	Effect.tryPromise({
		try: () => request.json(),
		catch: () => new FateRequestError("BAD_REQUEST", "Request body must be valid JSON."),
	});

/** Encode results onto the wire response — fate's `Response.json`, bound. */
const respond = (
	results: ReadonlyArray<OperationResultValue>,
	status: number,
): Effect.Effect<Response> =>
	encodeProtocolResponse({results, version: 1}).pipe(
		Effect.map((body) => Response.json(body, {headers: JSON_HEADERS, status})),
	);

/**
 * The interpreter's request handler — fate's `handleRequest` as one Effect:
 * decode, dispatch concurrently, encode; a request-level failure (malformed
 * JSON/protocol) serializes as fate's single `id: "request"` error result
 * with the error's own status.
 *
 * No runtime is owned here: the caller runs the program — the worker route
 * yields it on the request fiber (the platform layer's `runPromiseExit` is
 * the conversion point); the oracle runs it through a test ManagedRuntime.
 * Interrupts/abort signals are the caller's concern for the same reason
 * (the route wires the request's abort signal to fiber interruption).
 */
const handleRequest = (
	request: Request,
	context: FateRequestContext,
): Effect.Effect<Response, never, FateServer> =>
	Effect.gen(function* () {
		const server = yield* FateServer;
		// ONE walk per request — its RequestResolver instance IS the batch
		// window, so it must exist before the dispatch loop fans out.
		const walk = makeWalk(server, context);
		// ONE provision pipeline per request (`Provision.ts` — the pair as
		// request VALUES over the captured services); every operation applies it.
		const provide = provideRequestPair(context, server.services);
		const exit = yield* Effect.exit(
			Effect.gen(function* () {
				const body = yield* parseBody(request);
				const operations = yield* decodeProtocolRequest(body);
				const results = yield* Effect.forEach(
					operations,
					(operation) => runOperation(server, walk, provide, operation),
					{concurrency: "unbounded"},
				);
				return yield* respond(results, 200);
			}),
		);
		if (Exit.isSuccess(exit)) {
			return exit.value;
		}
		// fate's handleRequest catch: toProtocolError + the FateRequestError's
		// own status (500 for anything else).
		const failure = failureOf(exit.cause);
		const status = failure instanceof FateRequestError ? failure.status : 500;
		return yield* respond(
			[{error: toProtocolErrorValue(failure), id: "request", ok: false}],
			status,
		);
	});

/**
 * The v2 interpreter surface — the request handler the worker's `/fate`
 * route serves (and the differential oracle exercises against the v1
 * compiled baseline).
 */
export const FateInterpreter = {
	handleRequest,
};
