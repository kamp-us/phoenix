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
 *      Each operation provides the per-request pair as VALUES off the
 *      request context, then the captured build-time services — the same
 *      provision pipeline as the v1 compiler's `runResolve`, minus the
 *      Promise hop: no runtime here, the program stays an Effect and the
 *      caller (the oracle today, the platform layer at the task-17 cutover)
 *      owns the run.
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
 * under selected list-kind fields). The full operation surface is
 * oracle-green; what remains is the task-17 `route()` cutover.
 *
 * Raw legacy records (`kind: undefined` config arms) are NOT interpreted —
 * the live config has none since the v1 cutover (ADR 0042 marks the arms
 * v2-slated for removal) — and also fail closed.
 */
import {FateRequestError} from "@nkzw/fate/server";
import {Cause, Effect, Exit, Option} from "effect";
import {CurrentUser} from "./CurrentUser.ts";
import type {FateRequestContext} from "./Executor.ts";
import {LivePublisher} from "./LivePublisher.ts";
import type {
	DecodedProtocolOperation,
	ProtocolNamedOperation,
	ProtocolResponse,
} from "./Protocol.ts";
import {decodeProtocolRequest, encodeProtocolResponse} from "./Protocol.ts";
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
 * erased→kernel: re-pin an erased entry effect's requirements to `never` —
 * the same contained narrowing as the v1 compiler's `toRunnable`
 * (`Executor.ts`): the REAL requirements were enforced at the definition
 * site and discharged by `FateServer.layer`'s public R; the erased shapes
 * carry `R = unknown` only because every entry assigns into the config
 * records. A genuinely missing service still fails loudly at run time.
 */
const toRunnable = <A>(
	effect: Effect.Effect<A, unknown, unknown>,
): Effect.Effect<A, unknown, never> => effect as Effect.Effect<A, unknown, never>;

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

/** Operation kinds pending their interpreter plane (fails closed until then). */
const pending = (what: string): Effect.Effect<never> =>
	Effect.die(new Error(`fate-effect interpreter: ${what} is not interpreted yet`));

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
			if (entry.kind === undefined) {
				return pending(`raw legacy list "${name}"`);
			}
			return entry.resolve({args: operation.args, select: operation.select});
		}
		case "query": {
			const entry = Object.hasOwn(server.queries, name) ? server.queries[name] : undefined;
			if (entry === undefined) {
				return Effect.fail(new FateRequestError("NOT_FOUND", `No query registered for '${name}'.`));
			}
			if (entry.kind === undefined) {
				return pending(`raw legacy query "${name}"`);
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
			if (entry.kind === undefined) {
				return pending(`raw legacy mutation "${name}"`);
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
	context: FateRequestContext,
	operation: DecodedProtocolOperation,
): Effect.Effect<OperationResultValue> =>
	toRunnable(
		operationEffect(server, walk, operation).pipe(
			// The per-request pair as VALUES — the request context wins over
			// anything beneath (the v1 compiler's provision order, verbatim).
			Effect.provideService(CurrentUser, context.currentUser),
			Effect.provideService(LivePublisher, context.livePublisher),
			Effect.provideContext(server.services),
		),
	).pipe(
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
 * No runtime is owned here: the caller runs the program (the oracle through
 * a test ManagedRuntime today; the platform layer at the task-17 `route()`
 * cutover). Per-operation interrupts/signals are the caller's concern for
 * the same reason.
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
		const exit = yield* Effect.exit(
			Effect.gen(function* () {
				const body = yield* parseBody(request);
				const operations = yield* decodeProtocolRequest(body);
				const results = yield* Effect.forEach(
					operations,
					(operation) => runOperation(server, walk, context, operation),
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
 * The v2 interpreter surface. Today: the oracle-exercised request handler.
 * Task 17 wraps it as `FateExecutor.route` and retires the v1 request path.
 */
export const FateInterpreter = {
	handleRequest,
};
