/**
 * The shared differential-oracle fixture (tasks.md task 14; PRD story 16):
 * the dual-stack harness plus the ONE sozluk-shaped fixture world consumed by
 * every suite that drives a compiled or interpreted fate server.
 *
 * - `Executor.test.ts` pins the v1 compiled server (the oracle's baseline)
 *   directly over this world.
 * - The `Interpreter*.test.ts` oracle files run every protocol request
 *   through BOTH backends — `makeV1` (fate's own `handleRequest` over
 *   `FateExecutor.toFetchHandler`) and `makeV2` (the native interpreter) —
 *   and `assertParity` requires the raw wire output to be BYTE-EQUAL: same
 *   status, same content-type, same body text, same publishes. Each backend
 *   owns an isolated runtime over its own fresh in-memory database, so
 *   mutations advance both worlds in lockstep and later reads prove state
 *   parity, not just response parity.
 *
 * Not a test file: the vitest glob only collects `*.test.ts`, and the
 * conversion-point enumeration sweeps non-test, non-fixture sources — the
 * `runtime.runPromise` inside `makeV2` is harness plumbing standing in for
 * the platform layer's request fiber, not a package conversion point.
 */
import type {ConnectionResult} from "@nkzw/fate/server";
import {FateRequestError} from "@nkzw/fate/server";
import {Context, Effect, Layer, ManagedRuntime, Option} from "effect";
import * as Schema from "effect/Schema";
import {expect} from "vitest";
import {CurrentUser, type CurrentUserInfo, Unauthorized} from "./CurrentUser.ts";
import {FateDataView} from "./DataView.ts";
import {FateInterpreter} from "./Interpreter.ts";
import {Fate, FateExecutor} from "./index.ts";
import {LivePublisher} from "./LivePublisher.ts";
import type {FateRequestContext} from "./RequestContext.ts";
import {FateServer} from "./Server.ts";
import {fateWireCode} from "./WireError.ts";

// --- span observation channel ------------------------------------------------------
//
// The term handler and Term source log the span they run under; the
// observability suites reset `spanLog` and assert nesting. The oracle suites
// never read it — the pushes are inert there.

/** What the probe handlers observed: span name + parent span id. */
export const spanLog: Array<{name: string; parent: string | undefined}> = [];

export const logSpan = Effect.gen(function* () {
	const span = yield* Effect.orDie(Effect.currentSpan);
	spanLog.push({
		name: span.name,
		parent: Option.isSome(span.parent) ? span.parent.value.spanId : undefined,
	});
});

// --- fixture rows + views (sozluk-shaped) ------------------------------------------

export type TermRow = {
	slug: string;
	title: string;
};

export type DefinitionRow = {
	id: string;
	body: string;
	term: string;
	author: string;
	votes: number;
};

export class TermView extends FateDataView<TermRow>()("Term")({
	slug: true,
	title: true,
}) {}

export class DefinitionView extends FateDataView<DefinitionRow>()("Definition")({
	id: true,
	body: true,
	term: true,
	author: true,
	votes: true,
}) {}

// --- the in-memory database (the T1 seam: mutable state behind a service) ----------

export class SozlukDb extends Context.Service<
	SozlukDb,
	{
		readonly terms: Array<TermRow>;
		readonly definitions: Array<DefinitionRow>;
	}
>()("@phoenix/fate-effect/test/SozlukDb") {}

/** A fresh in-memory database per layer build — each backend owns its own world. */
export const SozlukDbLive = Layer.sync(SozlukDb, () => ({
	terms: [
		{slug: "effect", title: "Effect"},
		{slug: "fate", title: "fate"},
	],
	definitions: [],
}));

// --- fixture errors -----------------------------------------------------------------

export class BodyRequired extends Schema.TaggedErrorClass<BodyRequired>()(
	"test/BodyRequired",
	{message: Schema.String},
	{[fateWireCode]: "BODY_REQUIRED"},
) {}

export class DefinitionNotFound extends Schema.TaggedErrorClass<DefinitionNotFound>()(
	"test/DefinitionNotFound",
	{message: Schema.String},
	{[fateWireCode]: "VOTE_TARGET_NOT_FOUND"},
) {}

// --- the operation config (sozluk's shapes over the in-memory db) -------------------

export const termSource = Fate.source(
	TermView,
	{id: "slug"},
	{
		byIds: function* (slugs) {
			yield* logSpan;
			const db = yield* SozlukDb;
			return db.terms.filter((row) => slugs.includes(row.slug));
		},
	},
);

export const definitionSource = Fate.source(
	DefinitionView,
	{id: "id"},
	{
		byId: function* (id) {
			const db = yield* SozlukDb;
			return db.definitions.find((row) => row.id === id) ?? null;
		},
	},
);

export const sozlukQueries = {
	// Decode evidence: `take` is FiniteFromString — the wire sends a string,
	// the handler sees a number (the Schema ran before the handler).
	term: Fate.query(
		{
			args: Schema.Struct({slug: Schema.String, take: Schema.optional(Schema.FiniteFromString)}),
			type: TermView,
		},
		Effect.fn("term")(function* ({args}) {
			yield* logSpan;
			const db = yield* SozlukDb;
			const row = db.terms.find((term) => term.slug === args.slug) ?? null;
			return row === null ? null : {...row, take: args.take ?? null};
		}),
	),
	definitions: Fate.query(
		{args: Schema.Struct({term: Schema.String}), type: DefinitionView},
		Effect.fn("definitions")(function* ({args}) {
			const db = yield* SozlukDb;
			return db.definitions.filter((row) => row.term === args.term);
		}),
	),
	// An undeclared defect: the detail must not reach the wire on EITHER side.
	boom: Fate.query({type: "Boom"}, () => Effect.die(new Error("secret-db-detail"))),
	// A died FateRequestError passes through verbatim — including `issues`.
	forbidden: Fate.query({type: "Forbidden"}, () =>
		Effect.die(new FateRequestError("FORBIDDEN", "yasak", {issues: [{path: "session"}]})),
	),
};

export const sozlukLists = {
	terms: Fate.list(
		{args: Schema.Struct({first: Schema.optional(Schema.Number)}), type: TermView},
		Effect.fn("terms")(function* ({args}) {
			const db = yield* SozlukDb;
			const take = args.first ?? 10;
			const result: ConnectionResult<TermRow> = {
				items: db.terms.slice(0, take).map((row) => ({cursor: row.slug, node: row})),
				pagination: {hasNext: db.terms.length > take, hasPrevious: false},
			};
			return result;
		}),
	),
};

export const sozlukMutations = {
	"definition.add": Fate.mutation(
		{
			input: Schema.Struct({term: Schema.String, body: Schema.String}),
			type: DefinitionView,
			error: Schema.Union([Unauthorized, BodyRequired]),
		},
		Effect.fn("definition.add")(function* ({input}) {
			const author = yield* CurrentUser.required;
			if (input.body === "") {
				return yield* new BodyRequired({message: "tanım boş olamaz"});
			}
			const db = yield* SozlukDb;
			const definition: DefinitionRow = {
				id: `def-${db.definitions.length + 1}`,
				body: input.body,
				term: input.term,
				author: author.id,
				votes: 0,
			};
			db.definitions.push(definition);
			const live = yield* LivePublisher;
			yield* live
				.connection("Term.definitions", {term: input.term})
				.appendNode("Definition", definition.id, {node: definition});
			return definition;
		}),
	),
	"definition.vote": Fate.mutation(
		{
			input: Schema.Struct({id: Schema.String}),
			type: DefinitionView,
			error: Schema.Union([Unauthorized, DefinitionNotFound]),
		},
		Effect.fn("definition.vote")(function* ({input}) {
			yield* CurrentUser.required;
			const db = yield* SozlukDb;
			const definition = db.definitions.find((row) => row.id === input.id);
			if (definition === undefined) {
				return yield* new DefinitionNotFound({message: `tanım yok: ${input.id}`});
			}
			definition.votes += 1;
			const live = yield* LivePublisher;
			yield* live.update("Definition", definition.id);
			return definition;
		}),
	),
};

export const sozlukConfig = FateServer.config({
	queries: sozlukQueries,
	lists: sozlukLists,
	mutations: sozlukMutations,
	sources: [termSource, definitionSource],
});

// --- the dual-stack harness ---------------------------------------------------------

export const user = (id: string): CurrentUserInfo => ({id, email: `${id}@kamp.us`, name: id});

/** A recording per-request publisher — publish parity is asserted alongside bytes. */
export const recordingPublisher = (): {
	publisher: typeof LivePublisher.Service;
	calls: Array<string>;
} => {
	const calls: Array<string> = [];
	const push = (line: string) =>
		Effect.sync(() => {
			calls.push(line);
		});
	const publisher: typeof LivePublisher.Service = {
		update: (type, id) => push(`update ${type}:${id}`),
		delete: (type, id) => push(`delete ${type}:${id}`),
		connection: (procedure, args) => ({
			appendNode: (nodeType, id) =>
				push(`append ${procedure}(${JSON.stringify(args ?? {})}) ${nodeType}:${id}`),
			prependNode: (nodeType, id) =>
				push(`prepend ${procedure}(${JSON.stringify(args ?? {})}) ${nodeType}:${id}`),
			deleteEdge: (nodeType, id) =>
				push(`deleteEdge ${procedure}(${JSON.stringify(args ?? {})}) ${nodeType}:${id}`),
			invalidate: () => push(`invalidate ${procedure}(${JSON.stringify(args ?? {})})`),
		}),
	};
	return {publisher, calls};
};

export interface OracleBackend {
	readonly handle: (request: Request, context: FateRequestContext) => Promise<Response>;
	readonly dispose: () => Promise<void>;
}

/** The v1 side: the compiled fate server over its own runtime + database. */
export const makeV1 = (): OracleBackend => {
	const runtime = ManagedRuntime.make(
		FateServer.layer(sozlukConfig).pipe(Layer.provide(SozlukDbLive)),
	);
	return {
		handle: FateExecutor.toFetchHandler(runtime),
		dispose: () => runtime.dispose(),
	};
};

/** The v2 side: the native interpreter over its own runtime + database. */
export const makeV2 = (): OracleBackend => {
	const runtime = ManagedRuntime.make(
		FateServer.layer(sozlukConfig).pipe(Layer.provide(SozlukDbLive)),
	);
	return {
		handle: (request, context) =>
			runtime.runPromise(FateInterpreter.handleRequest(request, context)),
		dispose: () => runtime.dispose(),
	};
};

/** One corpus step: a wire request (or raw body) plus its request context. */
export interface OracleStep {
	readonly label: string;
	readonly operations?: ReadonlyArray<Record<string, unknown>>;
	readonly body?: unknown;
	readonly rawBody?: string;
	readonly user?: CurrentUserInfo;
}

export const requestOf = (step: OracleStep): Request =>
	new Request("https://test.local/fate", {
		method: "POST",
		headers: {"content-type": "application/json"},
		body:
			step.rawBody ?? JSON.stringify(step.body ?? {version: 1, operations: step.operations ?? []}),
	});

export interface OracleObservation {
	readonly status: number;
	readonly contentType: string | null;
	readonly text: string;
	readonly published: ReadonlyArray<string>;
}

export const observe = async (
	backend: OracleBackend,
	step: OracleStep,
): Promise<OracleObservation> => {
	const {publisher, calls} = recordingPublisher();
	const context: FateRequestContext = {
		currentUser: {user: step.user},
		livePublisher: publisher,
	};
	const response = await backend.handle(requestOf(step), context);
	return {
		status: response.status,
		contentType: response.headers.get("content-type"),
		text: await response.text(),
		published: calls,
	};
};

/** Run one step through both backends and assert byte-equality of the wire. */
export const assertParity = async (
	v1: OracleBackend,
	v2: OracleBackend,
	step: OracleStep,
): Promise<OracleObservation> => {
	const baseline = await observe(v1, step);
	const candidate = await observe(v2, step);
	expect(candidate.text, step.label).toBe(baseline.text);
	expect(candidate.status, step.label).toBe(baseline.status);
	expect(candidate.contentType, step.label).toBe(baseline.contentType);
	expect(candidate.published, step.label).toEqual(baseline.published);
	return baseline;
};
