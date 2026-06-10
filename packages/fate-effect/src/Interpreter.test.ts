/**
 * `FateInterpreter` — the v2 dispatch loop under the DIFFERENTIAL ORACLE
 * (tasks.md task 14; PRD story 16).
 *
 * The oracle's contract: any protocol request runs through BOTH backends —
 * the v1 compiled server (fate's own `handleRequest` over
 * `FateExecutor.toFetchHandler`) and the v2 native interpreter
 * (`FateInterpreter.handleRequest`) — and the raw wire output must be
 * BYTE-EQUAL: same status, same content-type, same body text. Each backend
 * owns an isolated runtime over its own fresh in-memory database (the
 * `Executor.test.ts` harness shape, sozluk-flavored), so mutations advance
 * both worlds in lockstep and later reads prove state parity, not just
 * response parity.
 *
 * The corpus covers query and mutation operations end to end — successes,
 * every error class (annotated, UNAUTHORIZED, VALIDATION_ERROR, NOT_FOUND,
 * defects, `FateRequestError` passthrough with issues), batching/order,
 * dispatch-time BAD_REQUESTs, request-level malformed-protocol rejections,
 * and fate's acceptance leniency. byId rides the selection walk (task 15);
 * connections complete the corpus (task 16).
 */
import type {ConnectionResult} from "@nkzw/fate/server";
import {FateRequestError} from "@nkzw/fate/server";
import {Context, Effect, Layer, ManagedRuntime} from "effect";
import * as Schema from "effect/Schema";
import {describe, expect, it} from "vitest";
import {CurrentUser, type CurrentUserInfo, Unauthorized} from "./CurrentUser.ts";
import {FateDataView} from "./DataView.ts";
import type {FateRequestContext} from "./Executor.ts";
import {FateExecutor} from "./Executor.ts";
import {FateInterpreter} from "./Interpreter.ts";
import {Fate} from "./index.ts";
import {LivePublisher} from "./LivePublisher.ts";
import {FateServer} from "./Server.ts";
import {fateWireCode} from "./WireError.ts";

// --- fixture rows + views (sozluk-shaped, as Executor.test.ts) -------------------

type TermRow = {
	slug: string;
	title: string;
};

type DefinitionRow = {
	id: string;
	body: string;
	term: string;
	author: string;
	votes: number;
};

class TermView extends FateDataView<TermRow>()("Term")({
	slug: true,
	title: true,
}) {}

class DefinitionView extends FateDataView<DefinitionRow>()("Definition")({
	id: true,
	body: true,
	term: true,
	author: true,
	votes: true,
}) {}

class SozlukDb extends Context.Service<
	SozlukDb,
	{
		readonly terms: Array<TermRow>;
		readonly definitions: Array<DefinitionRow>;
	}
>()("@phoenix/fate-effect/test/OracleSozlukDb") {}

/** A fresh database per layer build — each backend owns its own world. */
const SozlukDbLive = Layer.sync(SozlukDb, () => ({
	terms: [
		{slug: "effect", title: "Effect"},
		{slug: "fate", title: "fate"},
	],
	definitions: [],
}));

class BodyRequired extends Schema.TaggedErrorClass<BodyRequired>()(
	"test/BodyRequired",
	{message: Schema.String},
	{[fateWireCode]: "BODY_REQUIRED"},
) {}

class DefinitionNotFound extends Schema.TaggedErrorClass<DefinitionNotFound>()(
	"test/DefinitionNotFound",
	{message: Schema.String},
	{[fateWireCode]: "VOTE_TARGET_NOT_FOUND"},
) {}

// --- the oracle config (sozluk's operation shapes over the in-memory db) ---------

const termSource = Fate.source(
	TermView,
	{id: "slug"},
	{
		byIds: function* (slugs) {
			const db = yield* SozlukDb;
			return db.terms.filter((row) => slugs.includes(row.slug));
		},
	},
);

const definitionSource = Fate.source(
	DefinitionView,
	{id: "id"},
	{
		byId: function* (id) {
			const db = yield* SozlukDb;
			return db.definitions.find((row) => row.id === id) ?? null;
		},
	},
);

const queries = {
	term: Fate.query(
		{
			args: Schema.Struct({slug: Schema.String, take: Schema.optional(Schema.FiniteFromString)}),
			type: TermView,
		},
		Effect.fn("term")(function* ({args}) {
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

const lists = {
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

const mutations = {
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

const oracleConfig = FateServer.config({
	queries,
	lists,
	mutations,
	sources: [termSource, definitionSource],
});

// --- the dual-stack harness -------------------------------------------------------

const user = (id: string): CurrentUserInfo => ({id, email: `${id}@kamp.us`, name: id});

/** A recording per-request publisher — publish parity is asserted alongside bytes. */
const recordingPublisher = (): {
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

interface OracleBackend {
	readonly handle: (request: Request, context: FateRequestContext) => Promise<Response>;
	readonly dispose: () => Promise<void>;
}

/** The v1 side: the compiled fate server over its own runtime + database. */
const makeV1 = (): OracleBackend => {
	const runtime = ManagedRuntime.make(
		FateServer.layer(oracleConfig).pipe(Layer.provide(SozlukDbLive)),
	);
	return {
		handle: FateExecutor.toFetchHandler(runtime),
		dispose: () => runtime.dispose(),
	};
};

/** The v2 side: the native interpreter over its own runtime + database. */
const makeV2 = (): OracleBackend => {
	const runtime = ManagedRuntime.make(
		FateServer.layer(oracleConfig).pipe(Layer.provide(SozlukDbLive)),
	);
	return {
		handle: (request, context) =>
			runtime.runPromise(FateInterpreter.handleRequest(request, context)),
		dispose: () => runtime.dispose(),
	};
};

/** One corpus step: a wire request (or raw body) plus its request context. */
interface OracleStep {
	readonly label: string;
	readonly operations?: ReadonlyArray<Record<string, unknown>>;
	readonly body?: unknown;
	readonly rawBody?: string;
	readonly user?: CurrentUserInfo;
}

const requestOf = (step: OracleStep): Request =>
	new Request("https://test.local/fate", {
		method: "POST",
		headers: {"content-type": "application/json"},
		body:
			step.rawBody ?? JSON.stringify(step.body ?? {version: 1, operations: step.operations ?? []}),
	});

interface OracleObservation {
	readonly status: number;
	readonly contentType: string | null;
	readonly text: string;
	readonly published: ReadonlyArray<string>;
}

const observe = async (backend: OracleBackend, step: OracleStep): Promise<OracleObservation> => {
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
const assertParity = async (
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

// --- the harness itself (one operation, raw wire JSON diffed) ---------------------

describe("the differential oracle harness", () => {
	it("runs one operation through both backends and diffs the raw wire JSON", async () => {
		const v1 = makeV1();
		const v2 = makeV2();
		try {
			const baseline = await assertParity(v1, v2, {
				label: "term query",
				operations: [
					{id: "1", kind: "query", name: "term", args: {slug: "effect", take: "2"}, select: []},
				],
			});
			// The diffed output is fate's own wire JSON (sanity: not vacuous).
			expect(JSON.parse(baseline.text)).toEqual({
				results: [{data: {slug: "effect", take: 2, title: "Effect"}, id: "1", ok: true}],
				version: 1,
			});
			expect(baseline.status).toBe(200);
		} finally {
			await v1.dispose();
			await v2.dispose();
		}
	});
});

// --- the corpus (queries + mutations, success and error, in lockstep) -------------

describe("the sozluk oracle corpus — queries and mutations", () => {
	it("every corpus step is byte-equal across both backends", async () => {
		const umut = user("umut");
		const steps: ReadonlyArray<OracleStep> = [
			// -- queries: success shapes --
			{
				label: "query success with Schema-decoded args",
				operations: [
					{id: "1", kind: "query", name: "term", args: {slug: "effect", take: "2"}, select: []},
				],
			},
			{
				label: "query miss yields null data",
				operations: [{id: "1", kind: "query", name: "term", args: {slug: "yok"}, select: []}],
			},
			{
				label: "empty operations array",
				operations: [],
			},
			// -- queries: error shapes --
			{
				label: "unknown query is NOT_FOUND",
				operations: [{id: "1", kind: "query", name: "nope", select: []}],
			},
			{
				label: "query args rejected by the definition Schema",
				operations: [{id: "1", kind: "query", name: "term", args: {slug: 42}, select: []}],
			},
			{
				label: "defect collapses to the fixed internal error",
				operations: [{id: "1", kind: "query", name: "boom", select: []}],
			},
			{
				label: "died FateRequestError passes through verbatim, issues included",
				operations: [{id: "1", kind: "query", name: "forbidden", select: []}],
			},
			{
				label: "empty operation name is a per-operation BAD_REQUEST",
				operations: [{id: "1", kind: "query", name: "", select: []}],
			},
			// -- fate's acceptance leniency --
			{
				label: "junk in kind-unchecked fields is accepted and ignored",
				operations: [
					{
						id: "1",
						kind: "query",
						name: "term",
						args: {slug: "fate"},
						select: [],
						ids: "junk",
						type: 42,
					},
				],
			},
			// -- mutations: the write path, advancing both worlds --
			{
				label: "anonymous mutation is UNAUTHORIZED",
				operations: [
					{
						id: "1",
						kind: "mutation",
						name: "definition.add",
						input: {term: "effect", body: "tanım"},
						select: [],
					},
				],
			},
			{
				label: "mutation success writes and publishes",
				user: umut,
				operations: [
					{
						id: "1",
						kind: "mutation",
						name: "definition.add",
						input: {term: "effect", body: "bir efekt sistemi"},
						select: [],
					},
				],
			},
			{
				label: "a later read observes the write (state parity)",
				operations: [
					{id: "1", kind: "query", name: "definitions", args: {term: "effect"}, select: []},
				],
			},
			{
				label: "declared annotated error keeps its wire code",
				user: umut,
				operations: [
					{
						id: "1",
						kind: "mutation",
						name: "definition.add",
						input: {term: "effect", body: ""},
						select: [],
					},
				],
			},
			{
				label: "invalid mutation input is VALIDATION_ERROR",
				user: umut,
				operations: [
					{id: "1", kind: "mutation", name: "definition.add", input: {term: 1}, select: []},
				],
			},
			{
				label: "unknown mutation is NOT_FOUND",
				user: umut,
				operations: [{id: "1", kind: "mutation", name: "definition.nope", input: {}, select: []}],
			},
			{
				label: "vote mutation mutates prior state",
				user: umut,
				operations: [
					{id: "1", kind: "mutation", name: "definition.vote", input: {id: "def-1"}, select: []},
				],
			},
			{
				label: "vote on a missing target is the annotated error",
				user: umut,
				operations: [
					{id: "1", kind: "mutation", name: "definition.vote", input: {id: "def-99"}, select: []},
				],
			},
			// -- batching: order preserved, mixed outcomes. NOTE: no operation in
			// the batch reads what another WRITES — intra-batch read-after-write
			// is racy under BOTH backends (fate's Promise.all and the
			// interpreter's unbounded forEach interleave differently); only
			// cross-request reads are deterministic, and the oracle only pins
			// deterministic wire output. --
			{
				label: "a mixed batch preserves operation order",
				user: umut,
				operations: [
					{id: "a", kind: "query", name: "term", args: {slug: "fate"}, select: []},
					{id: "b", kind: "query", name: "nope", select: []},
					{id: "c", kind: "query", name: "boom", select: []},
					{
						id: "d",
						kind: "mutation",
						name: "definition.add",
						input: {term: "fate", body: "kader"},
						select: [],
					},
					// reads PRIOR-request state ("effect" definitions), not "fate"'s
					{id: "e", kind: "query", name: "definitions", args: {term: "effect"}, select: []},
				],
			},
			{
				label: "the batch write is visible to the NEXT request",
				operations: [
					{id: "1", kind: "query", name: "definitions", args: {term: "fate"}, select: []},
				],
			},
			// -- a list smoke case (full list/connection corpus lands in task 16) --
			{
				label: "list operation parity (smoke)",
				operations: [{id: "1", kind: "list", name: "terms", args: {first: 1}, select: []}],
			},
			{
				label: "unknown list is NOT_FOUND",
				operations: [{id: "1", kind: "list", name: "nope", select: []}],
			},
		];

		const v1 = makeV1();
		const v2 = makeV2();
		try {
			for (const step of steps) {
				await assertParity(v1, v2, step);
			}
		} finally {
			await v1.dispose();
			await v2.dispose();
		}
	});

	it("malformed protocol requests reject byte-equally, status included", async () => {
		const steps: ReadonlyArray<OracleStep> = [
			{label: "invalid JSON body", rawBody: "{nope"},
			{label: "wrong version", body: {version: 2, operations: []}},
			{label: "operations not an array", body: {version: 1, operations: {}}},
			{label: "non-record body", body: "x"},
			{label: "operation not a record", body: {version: 1, operations: ["x"]}},
			{
				label: "operation id not a string",
				body: {version: 1, operations: [{id: 1, kind: "query", name: "term", select: []}]},
			},
			{
				label: "unknown kind",
				body: {version: 1, operations: [{id: "1", kind: "nope", select: []}]},
			},
			{
				label: "select not strings",
				body: {version: 1, operations: [{id: "1", kind: "query", name: "term", select: [1]}]},
			},
			{
				label: "args not a record",
				body: {
					version: 1,
					operations: [{id: "1", kind: "query", name: "term", select: [], args: []}],
				},
			},
			{
				label: "byId without ids",
				body: {version: 1, operations: [{id: "1", kind: "byId", type: "Term", select: []}]},
			},
			{
				label: "named op without name",
				body: {version: 1, operations: [{id: "1", kind: "query", select: []}]},
			},
		];
		const v1 = makeV1();
		const v2 = makeV2();
		try {
			for (const step of steps) {
				const baseline = await assertParity(v1, v2, step);
				expect(baseline.status, step.label).toBe(400);
			}
		} finally {
			await v1.dispose();
			await v2.dispose();
		}
	});
});

// --- the dispatch loop runs operations concurrently --------------------------------

describe("FateInterpreter — concurrent dispatch", () => {
	it("operations within one request are in flight concurrently (fate's Promise.all)", async () => {
		// Both handlers hold at a 2-party barrier: sequential dispatch would
		// deadlock (vitest timeout); concurrent dispatch releases both.
		const waiters: Array<() => void> = [];
		const arrive = () =>
			new Promise<void>((resolve) => {
				waiters.push(resolve);
				if (waiters.length >= 2) {
					for (const release of waiters) {
						release();
					}
				}
			});
		const paired = Fate.query(
			{type: "Paired"},
			Effect.fn("paired")(function* () {
				yield* Effect.promise(() => arrive());
				return {ok: true};
			}),
		);
		const runtime = ManagedRuntime.make(FateServer.layer(FateServer.config({queries: {paired}})));
		try {
			const response = await runtime.runPromise(
				FateInterpreter.handleRequest(
					requestOf({
						label: "paired",
						operations: [
							{id: "1", kind: "query", name: "paired", select: []},
							{id: "2", kind: "query", name: "paired", select: []},
						],
					}),
					{currentUser: {user: undefined}, livePublisher: recordingPublisher().publisher},
				),
			);
			expect(JSON.parse(await response.text())).toEqual({
				results: [
					{data: {ok: true}, id: "1", ok: true},
					{data: {ok: true}, id: "2", ok: true},
				],
				version: 1,
			});
		} finally {
			await runtime.dispose();
		}
	});
});
