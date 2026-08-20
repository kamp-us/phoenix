/**
 * `FateInterpreter` — the v2 native dispatch loop: fate's `handleRequest` as
 * an Effect program. See ADR 0042 and ADR 0043 (the v2 cutover — this is the
 * serving path; `Executor.ts` survives only as the differential oracle's
 * baseline).
 *
 * Every stage is byte-faithful to the v1 compiled server; the oracle in the
 * `Interpreter*.test.ts` suites enforces it.
 */
import {FateRequestError} from "@nkzw/fate/server";
import {Effect, Exit} from "effect";
import type {
	DecodedProtocolOperation,
	ProtocolNamedOperation,
	ProtocolResponse,
} from "./Protocol.ts";
import {decodeProtocolRequest, encodeProtocolResponse} from "./Protocol.ts";
import {type ProvideRequestPair, provideRequestPair} from "./Provision.ts";
import type {FateRequestContext} from "./RequestContext.ts";
import type {FateServerService} from "./Server.ts";
import {FateServer} from "./Server.ts";
import type {FateWalk} from "./Walk.ts";
import {makeWalk} from "./Walk.ts";
import {encodeWireError, failureOf, internalArm} from "./WireError.ts";

type OperationResultValue = (typeof ProtocolResponse)["Type"]["results"][number];

type ProtocolErrorValue = Extract<OperationResultValue, {readonly ok: false}>["error"];

/** fate's response headers, byte for byte. */
const JSON_HEADERS = {"content-type": "application/json; charset=utf-8"};

/**
 * fate's `toProtocolError`, exactly: a `FateRequestError` keeps its code,
 * issues, and message; anything else derives from `internalArm()` — fate's
 * OWN internal arm (`code: "INTERNAL_ERROR"` — distinct from the annotation
 * codec's `INTERNAL_SERVER_ERROR`, which only per-operation failures
 * produce), the package's ONE construction site for those bytes
 * (`WireError.ts`). The conditional `issues` spread matches fate's
 * `issues: error.issues` + JSON.stringify dropping `undefined` —
 * `internalArm()` carries no issues, so the fallback serializes as
 * `{code, message}` exactly as fate's literal does.
 *
 * The fallback arm is provably dead per-operation (`runOperation` routes
 * every failure through `encodeWireError`, which always returns a
 * `FateRequestError`) and near-dead at request level (`parseBody` and
 * `decodeProtocolRequest` both fail with `FateRequestError`; `respond` DIES
 * on an encode failure) — it fires only on a defect inside the dispatch/
 * encode region, i.e. a package bug. No non-contrived test can reach it;
 * sharing `internalArm()` is the drift guard: the bytes are byte-pinned by
 * the walk oracle through the connection plane's reachable arms, and this
 * arm now has no spelling of its own to drift.
 */
const toProtocolErrorValue = (error: unknown): ProtocolErrorValue => {
	const wireError = error instanceof FateRequestError ? error : internalArm();
	return {
		code: wireError.code,
		...(wireError.issues !== undefined ? {issues: wireError.issues} : {}),
		message: wireError.message,
	};
};

/**
 * `Object.hasOwn` guards each lookup: fate indexes the raw record and would
 * trip over prototype names like `"constructor"`. That divergence from fate is
 * deliberate — a prototype name is NOT a registered operation.
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

const operationEffect = (
	server: FateServerService,
	walk: FateWalk,
	operation: DecodedProtocolOperation,
): Effect.Effect<unknown, unknown, unknown> => {
	if (operation.kind === "byId") {
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

/** Never fails: every failure and defect maps onto the protocol error arm. */
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

const parseBody = (request: Request): Effect.Effect<unknown, FateRequestError> =>
	Effect.tryPromise({
		try: () => request.json(),
		catch: () => new FateRequestError("BAD_REQUEST", "Request body must be valid JSON."),
	});

const respond = (
	results: ReadonlyArray<OperationResultValue>,
	status: number,
): Effect.Effect<Response> =>
	encodeProtocolResponse({results, version: 1}).pipe(
		Effect.map((body) => Response.json(body, {headers: JSON_HEADERS, status})),
	);

/**
 * No runtime is owned here: the caller runs the program, so interrupts and
 * abort signals are the caller's concern too (the worker route wires the
 * request's abort signal to fiber interruption).
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
		const failure = failureOf(exit.cause);
		const status = failure instanceof FateRequestError ? failure.status : 500;
		return yield* respond(
			[{error: toProtocolErrorValue(failure), id: "request", ok: false}],
			status,
		);
	});

export const FateInterpreter = {
	handleRequest,
};
