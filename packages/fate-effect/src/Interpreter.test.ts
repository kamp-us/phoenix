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
 * The corpus covers every operation kind end to end — successes, every error
 * class (annotated, UNAUTHORIZED, VALIDATION_ERROR, NOT_FOUND, defects,
 * `FateRequestError` passthrough with issues), batching/order, dispatch-time
 * BAD_REQUESTs, request-level malformed-protocol rejections, and fate's
 * acceptance leniency. byId rides the selection walk (task 15) with its
 * connection plane (task 16: scoped pagination args, in-array windowing,
 * cursor round-trips across pages), and the feature-shaped corpus at the end
 * pins pano / pasaport / stats operation shapes alongside the sozluk ones.
 */
import type {ConnectionResult, FieldSelection} from "@nkzw/fate/server";
import {
	computed,
	createFateServer,
	FateRequestError,
	field,
	hasNestedSelection,
	list,
	resolver,
} from "@nkzw/fate/server";
import {Context, Effect, Layer, ManagedRuntime, Option, Tracer} from "effect";
import * as Schema from "effect/Schema";
import {describe, expect, it} from "vitest";
import {CurrentUser, type CurrentUserInfo, Unauthorized} from "./CurrentUser.ts";
import {FateDataView} from "./DataView.ts";
import {compileFateSources} from "./Executor.ts";
import {FateInterpreter} from "./Interpreter.ts";
import {Fate, FateExecutor} from "./index.ts";
import {LivePublisher} from "./LivePublisher.ts";
import type {FateRequestContext} from "./RequestContext.ts";
import type {AnyFateSourceEntry} from "./Server.ts";
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

// --- the walk fixtures (task 15: byId + nested refs over static tables) -----------
//
// The walk corpus gets its OWN entity family (books/authors) over static
// in-memory tables: byId operations never mutate, so no per-backend database
// service is needed, and the sozluk fixtures above stay untouched.

type WalkAuthorRow = {id: string; name: string};
type WalkChapterRow = {id: string; title: string; pages: number};
type WalkReviewRow = {id: string; stars: number; secret: string};
type WalkBookRow = {
	id: string;
	title: string;
	year: number;
	author: WalkAuthorRow;
	coAuthors: Array<WalkAuthorRow>;
	chapters: Array<WalkChapterRow>;
	reviews?: ConnectionResult<WalkReviewRow>;
};

const ada: WalkAuthorRow = {id: "a1", name: "Ada Lovelace"};
const alan: WalkAuthorRow = {id: "a2", name: "Alan Turing"};
const grace: WalkAuthorRow = {id: "42", name: "Grace Hopper"};
const walkAuthors: ReadonlyArray<WalkAuthorRow> = [ada, alan, grace];

/** Raw chapter arrays ride ON the book rows — the walk's connection plane
 * (fate's `arrayToConnection` over a selected list-kind field) wraps them. */
const walkChapters: ReadonlyArray<WalkChapterRow> = [
	{id: "ch1", title: "Engines", pages: 12},
	{id: "ch2", title: "Tables", pages: 9},
	{id: "ch3", title: "Notes A–G", pages: 30},
	{id: "ch4", title: "Appendix", pages: 4},
	{id: "ch5", title: "Imitation", pages: 18},
	{id: "ch6", title: "Objections", pages: 22},
];

const chapterAt = (index: number): WalkChapterRow => {
	const chapter = walkChapters[index];
	if (chapter === undefined) {
		throw new Error(`walk fixture: no chapter at ${index}`);
	}
	return chapter;
};

/** A pre-shaped connection envelope on the row: the walk must pass it through
 * (per-entry node masking included), never re-wrap it. `secret` is the
 * masking canary. */
const walkReviews: ConnectionResult<WalkReviewRow> = {
	items: [
		{cursor: "r1", node: {id: "r1", stars: 5, secret: "gizli-1"}},
		{cursor: "r2", node: {id: "r2", stars: 3, secret: "gizli-2"}},
	],
	pagination: {hasNext: true, hasPrevious: false, nextCursor: "r2"},
};

const walkBooks: ReadonlyArray<WalkBookRow> = [
	{
		id: "b1",
		title: "Notes",
		year: 1843,
		author: ada,
		coAuthors: [],
		chapters: [chapterAt(0), chapterAt(1), chapterAt(2), chapterAt(3)],
		reviews: walkReviews,
	},
	{
		id: "b2",
		title: "Computing Machinery",
		year: 1950,
		author: alan,
		coAuthors: [ada, grace],
		chapters: [chapterAt(4), chapterAt(5)],
	},
	{id: "b3", title: "Compilers", year: 1952, author: grace, coAuthors: [alan], chapters: []},
];

/**
 * The author view carries every kernel field kind the walk must honor:
 * resolver fields (authorize-gated and plain), an `undefined`-returning
 * resolver (stays absent), throwing resolvers (raw error → fate's
 * INTERNAL_ERROR arm; `FateRequestError` → verbatim passthrough), and a
 * computed field with declared deps.
 */
class WalkAuthorView extends FateDataView<WalkAuthorRow>()("WalkAuthor")({
	id: true,
	name: true,
	email: resolver<WalkAuthorRow, string, FateRequestContext>({
		authorize: (_item, context) => Boolean(context?.currentUser.user),
		resolve: (item) => `${item.id}@kamp.us`,
	}),
	shout: resolver<WalkAuthorRow, string, FateRequestContext>({
		resolve: (item) => item.name.toUpperCase(),
	}),
	maybe: resolver<WalkAuthorRow, undefined, FateRequestContext>({
		resolve: () => undefined,
	}),
	cursed: resolver<WalkAuthorRow, never, FateRequestContext>({
		resolve: () => {
			throw new Error("kernel-detail-must-not-leak");
		},
	}),
	verboten: resolver<WalkAuthorRow, never, FateRequestContext>({
		resolve: () => {
			throw new FateRequestError("FORBIDDEN", "yasak alan");
		},
	}),
	initials: computed<WalkAuthorRow, string, FateRequestContext, {name: FieldSelection}>({
		select: {name: field("name")},
		resolve: (_item, deps) =>
			String(deps.name)
				.split(" ")
				.map((word) => word.slice(0, 1))
				.join(""),
	}),
}) {}

class WalkChapterView extends FateDataView<WalkChapterRow>()("WalkChapter")({
	id: true,
	title: true,
	pages: true,
}) {}

class WalkReviewView extends FateDataView<WalkReviewRow>()("WalkReview")({
	id: true,
	stars: true,
}) {}

class WalkBookView extends FateDataView<WalkBookRow>()("WalkBook")({
	id: true,
	title: true,
	year: true,
	// One-kind nested refs: a record-valued ref and an array of refs.
	author: WalkAuthorView.view,
	coAuthors: WalkAuthorView.view,
	// The connection plane: a list-kind field over raw arrays (chapters) and
	// over an already-shaped connection envelope (reviews).
	chapters: FateDataView.list(WalkChapterView),
	reviews: FateDataView.list(WalkReviewView),
}) {}

class WalkGhostView extends FateDataView<{id: string}>()("WalkGhost")({id: true}) {}
class WalkCursedView extends FateDataView<{id: string}>()("WalkCursed")({id: true}) {}

/** byIds-capable: SQL-IN-shaped (membership-stable, store-order rows). */
const walkBookSource = Fate.source(
	WalkBookView,
	{id: "id"},
	{
		byIds: (ids) => Effect.succeed(walkBooks.filter((row) => ids.includes(row.id))),
	},
);

/** byId-only: exercises fate's per-id fallback arm (ids order, duplicates kept). */
const walkAuthorSource = Fate.source(
	WalkAuthorView,
	{id: "id"},
	{
		byId: (id) => Effect.succeed(walkAuthors.find((row) => row.id === id) ?? null),
	},
);

/** Loaders for the connection-plane child entities (source-completeness:
 * every view-reachable entity needs one; the connection steps never load
 * them by id — chapters/reviews ride on the book rows). */
const walkChapterSource = Fate.source(
	WalkChapterView,
	{id: "id"},
	{
		byIds: (ids) => Effect.succeed(walkChapters.filter((row) => ids.includes(row.id))),
	},
);

const walkReviewSource = Fate.source(
	WalkReviewView,
	{id: "id"},
	{
		byIds: (ids) =>
			Effect.succeed(
				walkReviews.items.map((entry) => entry.node).filter((row) => ids.includes(row.id)),
			),
	},
);

/** Capability-less (the `contributionSource` shape): any load is fate's internal arm. */
const walkGhostSource: AnyFateSourceEntry = {
	typeName: "WalkGhost",
	definition: {id: "id", view: WalkGhostView.view},
	handlers: {},
};

/** A defecting loader: detail must not leak on either side. */
const walkCursedSource = Fate.source(
	WalkCursedView,
	{id: "id"},
	{
		byIds: () => Effect.die(new Error("driver-detail-must-not-leak")),
	},
);

const walkConfig = FateServer.config({
	sources: [
		walkBookSource,
		walkAuthorSource,
		walkChapterSource,
		walkReviewSource,
		walkGhostSource,
		walkCursedSource,
	],
});

/**
 * The v1 baseline for the WALK corpus is fate's OWN server — `createFateServer`
 * over the SAME compiled source executors (`compileFateSources` through the
 * same runtime/services pipeline the v1 compiled server uses) — with
 * `list()`-wrapped roots whose only job is to register the sources by type
 * (fate populates `sourcesByType` exclusively by visiting root views; a
 * `list()` root demands no matching resolver). The package's own v1 server
 * compiles `roots: {}` (ADR 0016/0019), which leaves fate's `sourcesByType`
 * EMPTY — its byId plane is unreachable dead code, so it cannot serve as the
 * walk's baseline. Fate's real dispatch + walk (`executeOperation` →
 * `resolveSourceByIds` → `resolveNode`/`filterToViewFields`) is the thing the
 * interpreter must match byte for byte, and this baseline makes it reachable.
 */
const makeWalkV1 = async (): Promise<OracleBackend> => {
	const runtime = ManagedRuntime.make(FateServer.layer(walkConfig));
	const service = await runtime.runPromise(
		Effect.gen(function* () {
			return yield* FateServer;
		}),
	);
	const walkRoots = {
		walkBooks: list(WalkBookView.view),
		walkCursed: list(WalkCursedView.view),
		walkGhosts: list(WalkGhostView.view),
	};
	const server = createFateServer<
		FateRequestContext,
		typeof walkRoots,
		Record<never, never>,
		Record<never, never>,
		Record<never, never>,
		FateRequestContext
	>({
		context: ({adapterContext}) => {
			if (!adapterContext) {
				throw new Error("walk baseline: the harness always supplies the request context.");
			}
			return adapterContext;
		},
		roots: walkRoots,
		sources: compileFateSources(walkConfig.sources, {runtime, services: service.services}),
	});
	return {
		handle: (request, context) => server.handleRequest(request, context),
		dispose: () => runtime.dispose(),
	};
};

/** The v2 side over the same walk config (the standard interpreter backend). */
const makeWalkV2 = (): OracleBackend => {
	const runtime = ManagedRuntime.make(FateServer.layer(walkConfig));
	return {
		handle: (request, context) =>
			runtime.runPromise(FateInterpreter.handleRequest(request, context)),
		dispose: () => runtime.dispose(),
	};
};

/** A structural record guard for digging into observed wire JSON. */
const isWireRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Read a nested connection envelope off a byId observation's wire text (first
 * result, first row). Throws loudly on shape mismatch — a corpus step that
 * needs this helper is asserting the envelope EXISTS.
 */
const connectionOf = (
	observation: OracleObservation,
	field: string,
): {
	readonly items: ReadonlyArray<{readonly cursor: unknown; readonly node: unknown}>;
	readonly pagination: Record<string, unknown>;
} => {
	const body: unknown = JSON.parse(observation.text);
	const results = isWireRecord(body) ? body.results : undefined;
	const first = Array.isArray(results) ? results[0] : undefined;
	const data = isWireRecord(first) ? first.data : undefined;
	const row = Array.isArray(data) ? data[0] : undefined;
	const connection = isWireRecord(row) ? row[field] : undefined;
	if (
		!isWireRecord(connection) ||
		!Array.isArray(connection.items) ||
		!isWireRecord(connection.pagination)
	) {
		throw new Error(`no connection envelope at "${field}" in: ${observation.text}`);
	}
	return {
		items: connection.items.map((entry) => {
			if (!isWireRecord(entry)) {
				throw new Error(`malformed connection entry in: ${observation.text}`);
			}
			return {cursor: entry.cursor, node: entry.node};
		}),
		pagination: connection.pagination,
	};
};

// --- the walk corpus (byId + nested refs, success and error, both backends) -------

describe("the walk oracle corpus — byId operations + nested ref selections", () => {
	it("every byId corpus step is byte-equal across fate's walk and the interpreter", async () => {
		const umut = user("umut");
		const steps: ReadonlyArray<OracleStep> = [
			{
				label: "byId with selection masking and a nested ref",
				operations: [
					{
						id: "1",
						kind: "byId",
						type: "WalkBook",
						ids: ["b1"],
						select: ["title", "author.name"],
					},
				],
			},
			{
				label: "byId resolves multiple ids in source order",
				operations: [
					{id: "1", kind: "byId", type: "WalkBook", ids: ["b3", "b1"], select: ["title"]},
				],
			},
			{
				label: "missing ids are silently fewer rows",
				operations: [
					{id: "1", kind: "byId", type: "WalkBook", ids: ["b1", "nope"], select: ["title"]},
				],
			},
			{
				label: "numeric wire ids coerce to strings before the source",
				operations: [{id: "1", kind: "byId", type: "WalkAuthor", ids: [42], select: ["name"]}],
			},
			{
				label: "nested array refs mask per entry",
				operations: [
					{
						id: "1",
						kind: "byId",
						type: "WalkBook",
						ids: ["b2"],
						select: ["title", "coAuthors.name"],
					},
				],
			},
			{
				label: "duplicate ids on a byId-only source keep ids order and duplicates",
				operations: [
					{id: "1", kind: "byId", type: "WalkAuthor", ids: ["a2", "a1", "a2"], select: ["name"]},
				],
			},
			{
				label: "an authorize-gated resolver field short-circuits to null anonymously",
				operations: [
					{
						id: "1",
						kind: "byId",
						type: "WalkAuthor",
						ids: ["a1"],
						select: ["name", "email", "shout"],
					},
				],
			},
			{
				label: "the same authorize gate passes for an authenticated user",
				user: umut,
				operations: [
					{
						id: "1",
						kind: "byId",
						type: "WalkAuthor",
						ids: ["a1"],
						select: ["name", "email", "shout"],
					},
				],
			},
			{
				label: "a computed field resolves with its declared deps",
				operations: [
					{id: "1", kind: "byId", type: "WalkAuthor", ids: ["a1"], select: ["initials"]},
				],
			},
			{
				label: "a resolver returning undefined stays absent",
				operations: [
					{id: "1", kind: "byId", type: "WalkAuthor", ids: ["a1"], select: ["name", "maybe"]},
				],
			},
			{
				label: "a throwing resolver field is fate's INTERNAL_ERROR arm",
				operations: [{id: "1", kind: "byId", type: "WalkAuthor", ids: ["a1"], select: ["cursed"]}],
			},
			{
				label: "a FateRequestError from a resolver field passes through verbatim",
				operations: [
					{id: "1", kind: "byId", type: "WalkAuthor", ids: ["a1"], select: ["verboten"]},
				],
			},
			{
				label: "unknown select paths and empty segments are ignored",
				operations: [
					{
						id: "1",
						kind: "byId",
						type: "WalkBook",
						ids: ["b1"],
						select: ["title", "nope.deep", ""],
					},
				],
			},
			{
				label: "empty select masks to the view's id",
				operations: [{id: "1", kind: "byId", type: "WalkBook", ids: ["b1"], select: []}],
			},
			{
				label: "byId with a falsy type is the dispatch-time BAD_REQUEST",
				operations: [{id: "1", kind: "byId", type: "", ids: [], select: []}],
			},
			{
				label: "byId for an unregistered type is NOT_FOUND",
				operations: [{id: "1", kind: "byId", type: "Nope", ids: ["x"], select: []}],
			},
			{
				label: "a capability-less source is fate's internal arm",
				operations: [{id: "1", kind: "byId", type: "WalkGhost", ids: ["g1"], select: ["id"]}],
			},
			{
				label: "a defecting loader collapses to the shared internal error",
				operations: [{id: "1", kind: "byId", type: "WalkCursed", ids: ["c1"], select: ["id"]}],
			},
			{
				label: "byId with empty ids is an empty result",
				operations: [{id: "1", kind: "byId", type: "WalkBook", ids: [], select: ["title"]}],
			},
			{
				label: "a mixed byId batch across sources, ids overlapping",
				operations: [
					{id: "a", kind: "byId", type: "WalkBook", ids: ["b1", "b2"], select: ["title"]},
					{id: "b", kind: "byId", type: "WalkAuthor", ids: ["a1"], select: ["name"]},
					{id: "c", kind: "byId", type: "WalkBook", ids: ["b2", "b3"], select: ["year"]},
					{id: "d", kind: "byId", type: "WalkAuthor", ids: ["a1", "a2"], select: ["shout"]},
				],
			},
			// -- the connection plane (task 16): raw arrays under list-kind fields --
			{
				label: "a raw array under a list field wraps without pagination args",
				operations: [
					{
						id: "1",
						kind: "byId",
						type: "WalkBook",
						ids: ["b1"],
						select: ["title", "chapters.title"],
					},
				],
			},
			{
				label: "scoped first windows the nested connection forward",
				operations: [
					{
						id: "1",
						kind: "byId",
						type: "WalkBook",
						ids: ["b1"],
						args: {chapters: {first: 2}},
						select: ["chapters.title"],
					},
				],
			},
			{
				label: "scoped last windows the nested connection backward",
				operations: [
					{
						id: "1",
						kind: "byId",
						type: "WalkBook",
						ids: ["b1"],
						args: {chapters: {last: 1}},
						select: ["chapters.title"],
					},
				],
			},
			{
				label: "scoped before windows backward from the cursor",
				operations: [
					{
						id: "1",
						kind: "byId",
						type: "WalkBook",
						ids: ["b1"],
						args: {chapters: {before: "ch3", last: 1}},
						select: ["chapters.title"],
					},
				],
			},
			{
				label: "an unknown nested cursor falls back to the full array",
				operations: [
					{
						id: "1",
						kind: "byId",
						type: "WalkBook",
						ids: ["b1"],
						args: {chapters: {first: 2, after: "nope"}},
						select: ["chapters.title"],
					},
				],
			},
			{
				label: "feature args in the scoped slice never reach the pagination schema",
				operations: [
					{
						id: "1",
						kind: "byId",
						type: "WalkBook",
						ids: ["b1"],
						args: {chapters: {first: 1, q: "junk"}},
						select: ["chapters.title"],
					},
				],
			},
			{
				label: "unscoped top-level args do not leak into the nested window",
				operations: [
					{
						id: "1",
						kind: "byId",
						type: "WalkBook",
						ids: ["b1"],
						args: {first: 2},
						select: ["chapters.title"],
					},
				],
			},
			{
				label: "an empty raw array still wraps into an empty connection",
				operations: [
					{id: "1", kind: "byId", type: "WalkBook", ids: ["b3"], select: ["chapters.title"]},
				],
			},
			{
				label: "each row of a multi-id byId windows its own connection",
				operations: [
					{
						id: "1",
						kind: "byId",
						type: "WalkBook",
						ids: ["b1", "b2"],
						args: {chapters: {first: 1}},
						select: ["title", "chapters.title"],
					},
				],
			},
			{
				label: "a pre-shaped connection envelope passes through with per-entry masking",
				operations: [
					{id: "1", kind: "byId", type: "WalkBook", ids: ["b1"], select: ["reviews.stars"]},
				],
			},
			// -- the rejection boundary: every invalid pagination bag is fate's
			//    masked internal arm (the zod throw rides `toProtocolError`) --
			{
				label: "scoped first: 0 is rejected as the internal arm",
				operations: [
					{
						id: "1",
						kind: "byId",
						type: "WalkBook",
						ids: ["b1"],
						args: {chapters: {first: 0}},
						select: ["chapters.title"],
					},
				],
			},
			{
				label: "scoped non-integer first is rejected as the internal arm",
				operations: [
					{
						id: "1",
						kind: "byId",
						type: "WalkBook",
						ids: ["b1"],
						args: {chapters: {first: 1.5}},
						select: ["chapters.title"],
					},
				],
			},
			{
				label: "scoped non-string after is rejected as the internal arm",
				operations: [
					{
						id: "1",
						kind: "byId",
						type: "WalkBook",
						ids: ["b1"],
						args: {chapters: {after: 7}},
						select: ["chapters.title"],
					},
				],
			},
			{
				label: "after+before together are rejected as the internal arm",
				operations: [
					{
						id: "1",
						kind: "byId",
						type: "WalkBook",
						ids: ["b1"],
						args: {chapters: {after: "ch1", before: "ch3"}},
						select: ["chapters.title"],
					},
				],
			},
			{
				label: "first+last together are rejected as the internal arm",
				operations: [
					{
						id: "1",
						kind: "byId",
						type: "WalkBook",
						ids: ["b1"],
						args: {chapters: {first: 1, last: 1}},
						select: ["chapters.title"],
					},
				],
			},
			{
				label: "the refine boundary is truthy: an empty-string cursor passes",
				operations: [
					{
						id: "1",
						kind: "byId",
						type: "WalkBook",
						ids: ["b1"],
						args: {chapters: {after: "", before: "ch3", last: 1}},
						select: ["chapters.title"],
					},
				],
			},
		];
		const v1 = await makeWalkV1();
		const v2 = makeWalkV2();
		try {
			for (const step of steps) {
				await assertParity(v1, v2, step);
			}
		} finally {
			await v1.dispose();
			await v2.dispose();
		}
	});

	it("nested connection cursors round-trip across pages, byte-equal on every page", async () => {
		// The keyset-lockstep AC (ADR 0019 discipline at the oracle level): page
		// 1's nextCursor — read off the BASELINE's wire output, not a fixture
		// constant — feeds page 2's `after`, and both pages byte-compare.
		const v1 = await makeWalkV1();
		const v2 = makeWalkV2();
		try {
			const pageOne = await assertParity(v1, v2, {
				label: "chapters page 1",
				operations: [
					{
						id: "1",
						kind: "byId",
						type: "WalkBook",
						ids: ["b1"],
						args: {chapters: {first: 2}},
						select: ["chapters.title"],
					},
				],
			});
			const cursor = connectionOf(pageOne, "chapters").pagination.nextCursor;
			expect(cursor).toBe("ch2");
			const pageTwo = await assertParity(v1, v2, {
				label: "chapters page 2 (after = page 1's nextCursor)",
				operations: [
					{
						id: "1",
						kind: "byId",
						type: "WalkBook",
						ids: ["b1"],
						args: {chapters: {first: 2, after: cursor}},
						select: ["chapters.title"],
					},
				],
			});
			// Page 2 is the remaining window (sanity: the round-trip moved).
			const connection = connectionOf(pageTwo, "chapters");
			expect(connection.items.map((entry) => entry.cursor)).toEqual(["ch3", "ch4"]);
			expect(connection.pagination).toEqual({
				hasNext: false,
				hasPrevious: true,
				nextCursor: "ch4",
				previousCursor: "ch3",
			});
		} finally {
			await v1.dispose();
			await v2.dispose();
		}
	});

	it("the diffed walk output is fate's real wire shape (sanity: not vacuous)", async () => {
		const v1 = await makeWalkV1();
		const v2 = makeWalkV2();
		try {
			const baseline = await assertParity(v1, v2, {
				label: "byId nested ref",
				operations: [
					{
						id: "1",
						kind: "byId",
						type: "WalkBook",
						ids: ["b1"],
						select: ["title", "author.name"],
					},
				],
			});
			expect(JSON.parse(baseline.text)).toEqual({
				results: [
					{
						data: [{author: {id: "a1", name: "Ada Lovelace"}, id: "b1", title: "Notes"}],
						id: "1",
						ok: true,
					},
				],
				version: 1,
			});
		} finally {
			await v1.dispose();
			await v2.dispose();
		}
	});
});

// --- the batch window (v2-only: where N+1 dies) ------------------------------------

type CountedRow = {id: string; label: string};

class CountedView extends FateDataView<CountedRow>()("Counted")({id: true, label: true}) {}
class SingularView extends FateDataView<CountedRow>()("Singular")({id: true, label: true}) {}

describe("FateInterpreter — RequestResolver-batched sources", () => {
	const makeCountingWorld = () => {
		const byIdsCalls: Array<ReadonlyArray<string>> = [];
		const byIdCalls: Array<string> = [];
		const countedRows: ReadonlyArray<CountedRow> = [
			{id: "c1", label: "bir"},
			{id: "c2", label: "iki"},
			{id: "c3", label: "üç"},
		];
		const singularRows: ReadonlyArray<CountedRow> = [
			{id: "s1", label: "tek"},
			{id: "s2", label: "çift"},
		];
		const counted = Fate.source(
			CountedView,
			{id: "id"},
			{
				byIds: (ids) =>
					Effect.sync(() => {
						byIdsCalls.push(ids);
						return countedRows.filter((row) => ids.includes(row.id));
					}),
			},
		);
		const singular = Fate.source(
			SingularView,
			{id: "id"},
			{
				byId: (id) =>
					Effect.sync(() => {
						byIdCalls.push(id);
						return singularRows.find((row) => row.id === id) ?? null;
					}),
			},
		);
		const runtime = ManagedRuntime.make(
			FateServer.layer(FateServer.config({sources: [counted, singular]})),
		);
		return {
			byIdCalls,
			byIdsCalls,
			dispose: () => runtime.dispose(),
			handle: (step: OracleStep) =>
				runtime
					.runPromise(
						FateInterpreter.handleRequest(requestOf(step), {
							currentUser: {user: undefined},
							livePublisher: recordingPublisher().publisher,
						}),
					)
					.then((response) => response.text())
					.then((text) => JSON.parse(text) as unknown),
		};
	};

	it("N same-entity byId operations in one protocol request make exactly ONE byIds call", async () => {
		const world = makeCountingWorld();
		try {
			const body = await world.handle({
				label: "one window",
				operations: [
					{id: "1", kind: "byId", type: "Counted", ids: ["c1", "c2"], select: ["label"]},
					{id: "2", kind: "byId", type: "Counted", ids: ["c2", "c3"], select: ["label"]},
					{id: "3", kind: "byId", type: "Counted", ids: ["c1"], select: ["label"]},
				],
			});
			expect(body).toEqual({
				results: [
					{
						data: [
							{id: "c1", label: "bir"},
							{id: "c2", label: "iki"},
						],
						id: "1",
						ok: true,
					},
					{
						data: [
							{id: "c2", label: "iki"},
							{id: "c3", label: "üç"},
						],
						id: "2",
						ok: true,
					},
					{data: [{id: "c1", label: "bir"}], id: "3", ok: true},
				],
				version: 1,
			});
			expect(world.byIdsCalls).toHaveLength(1);
			expect([...world.byIdsCalls.flat()].sort()).toEqual(["c1", "c2", "c3"]);
		} finally {
			await world.dispose();
		}
	});

	it("duplicate ids within a batch are deduped before reaching the source", async () => {
		const world = makeCountingWorld();
		try {
			await world.handle({
				label: "dupes",
				operations: [
					{id: "1", kind: "byId", type: "Counted", ids: ["c1", "c1", "c2"], select: ["label"]},
					{id: "2", kind: "byId", type: "Counted", ids: ["c2", "c1"], select: ["label"]},
				],
			});
			expect(world.byIdsCalls).toHaveLength(1);
			expect([...world.byIdsCalls.flat()].sort()).toEqual(["c1", "c2"]);
		} finally {
			await world.dispose();
		}
	});

	it("byId-only sources load each unique id once; per-op data keeps ids order and duplicates", async () => {
		const world = makeCountingWorld();
		try {
			const body = await world.handle({
				label: "byId-only dedupe",
				operations: [
					{id: "1", kind: "byId", type: "Singular", ids: ["s1", "s2", "s1"], select: ["label"]},
					{id: "2", kind: "byId", type: "Singular", ids: ["s2"], select: ["label"]},
				],
			});
			expect(body).toEqual({
				results: [
					{
						data: [
							{id: "s1", label: "tek"},
							{id: "s2", label: "çift"},
							{id: "s1", label: "tek"},
						],
						id: "1",
						ok: true,
					},
					{data: [{id: "s2", label: "çift"}], id: "2", ok: true},
				],
				version: 1,
			});
			expect([...world.byIdCalls].sort()).toEqual(["s1", "s2"]);
		} finally {
			await world.dispose();
		}
	});

	it("the batch window is one protocol request, not the runtime lifetime", async () => {
		const world = makeCountingWorld();
		try {
			const step: OracleStep = {
				label: "request 1",
				operations: [{id: "1", kind: "byId", type: "Counted", ids: ["c1"], select: ["label"]}],
			};
			await world.handle(step);
			await world.handle(step);
			expect(world.byIdsCalls).toHaveLength(2);
		} finally {
			await world.dispose();
		}
	});

	it("v2 serves byId from config.sources where the v1 compiled server (roots: {}) cannot", async () => {
		// DELIBERATE divergence, pinned loudly: the v1 compiled server passes
		// `roots: {}` (ADR 0016/0019), which leaves fate's `sourcesByType` empty —
		// every byId is NOT_FOUND and the registered sources are dead code. The
		// interpreter resolves byId from `config.sources` directly, making the
		// registered loaders reachable. fate's client CAN emit `kind: "byId"`
		// (cache-miss node fetches, missing-field refetches, and the
		// live-payload fallback in `fetchLiveRecord`) — v1 serves all of those
		// NOT_FOUND today, so the divergence is error→data: strictly additive
		// on the wire, and at cutover it FIXES the latent live-refetch
		// breakage rather than introducing one.
		const v1 = makeV1();
		const v2 = makeV2();
		const step: OracleStep = {
			label: "byId Term",
			operations: [
				{id: "1", kind: "byId", type: "Term", ids: ["effect"], select: ["slug", "title"]},
			],
		};
		try {
			const baseline = await observe(v1, step);
			const candidate = await observe(v2, step);
			expect(JSON.parse(baseline.text)).toEqual({
				results: [
					{
						error: {code: "NOT_FOUND", message: "No source registered for 'Term'."},
						id: "1",
						ok: false,
					},
				],
				version: 1,
			});
			expect(JSON.parse(candidate.text)).toEqual({
				results: [{data: [{slug: "effect", title: "Effect"}], id: "1", ok: true}],
				version: 1,
			});
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

// --- span nesting (the cutover observability AC, task 17 / ADR 0043) ---------------
//
// v2 owns no runtime: `handleRequest` runs on the CALLER's fiber, so every
// handler/source `Effect.fn` span must parent to the caller's ambient span —
// in production that is the router's request span (the `HttpEffect.toHandled`
// tracer middleware sets it on the request fiber). The harness simulates the
// route fiber by carrying a `Tracer.ParentSpan` in the runtime context, the
// same collector idiom as `Executor.test.ts` § observability. The byId arm is
// the risky one — source loads run through the walk's `RequestResolver`
// batch fiber, which must not detach from the request span.

describe("FateInterpreter — observability", () => {
	it("handler and batched-source spans nest under the route's request span", async () => {
		const spanLog: Array<{name: string; parent: string | undefined}> = [];
		const logSpan = Effect.gen(function* () {
			const span = yield* Effect.orDie(Effect.currentSpan);
			spanLog.push({
				name: span.name,
				parent: Option.isSome(span.parent) ? span.parent.value.spanId : undefined,
			});
		});

		class SpannedView extends FateDataView<{id: string}>()("Spanned")({id: true}) {}
		const spannedSource = Fate.source(
			SpannedView,
			{id: "id"},
			{
				byIds: function* (ids) {
					// Inside the constructor-owned `Spanned.byIds` span.
					yield* logSpan;
					return ids.map((id) => ({id}));
				},
			},
		);
		const spanned = Fate.query(
			{type: "Spanned"},
			Effect.fn("spanned")(function* () {
				yield* logSpan;
				return {ok: true};
			}),
		);

		// The runtime context carries the request span — the stand-in for the
		// route fiber's ambient `ParentSpan`.
		const runtime = ManagedRuntime.make(
			Layer.mergeAll(
				FateServer.layer(FateServer.config({queries: {spanned}, sources: [spannedSource]})),
				Layer.succeed(Tracer.ParentSpan)(
					Tracer.externalSpan({spanId: "route-span", traceId: "route-trace"}),
				),
			),
		);
		try {
			const response = await runtime.runPromise(
				FateInterpreter.handleRequest(
					requestOf({
						label: "spans",
						operations: [
							{id: "1", kind: "query", name: "spanned", select: []},
							{id: "2", kind: "byId", type: "Spanned", ids: ["s1"], select: ["id"]},
						],
					}),
					{currentUser: {user: undefined}, livePublisher: recordingPublisher().publisher},
				),
			);
			expect(response.status).toBe(200);
			// Both spans — the operation handler's wire-name span AND the source
			// handler's constructor-owned span (reached through the
			// RequestResolver batch window) — parent to the request span, never
			// a detached root.
			expect([...spanLog].sort((a, b) => (a.name < b.name ? -1 : 1))).toEqual([
				{name: "Spanned.byIds", parent: "route-span"},
				{name: "spanned", parent: "route-span"},
			]);
		} finally {
			await runtime.dispose();
		}
	});
});

// --- the feature-shaped corpus (task 16: every migrated feature's operation shapes) -
//
// AC: "the complete oracle corpus — every operation kind, every migrated
// feature, success and error paths". The sozluk corpus above carries the
// query/mutation taxonomy; this section adds the OTHER migrated features'
// distinctive shapes at the level the oracle needs (in-memory, not D1):
//
//   - pano   — `tags` as an EMBEDDED SCALAR array on the post row (never a
//              list relation), threaded comments as a resolver-owned inline
//              keyset connection, a keyset-cursored feed list, and a
//              publishing comment mutation.
//   - pasaport — `profile` stamping `id` === `userId`, the resolver-owned
//              `contributions` connection, and the CAPABILITY-LESS
//              `Contribution` source (no byId/byIds/connection by design).
//   - stats  — plain string-typed queries (`landingStats` has no data view).

type FxTagRow = {kind: string; label: string};
type FxCommentRow = {
	id: string;
	postId: string;
	parentId: string | null;
	author: string;
	body: string;
	score: number;
	createdAt: string;
};
type FxPostRow = {
	id: string;
	slug: string;
	title: string;
	tags: Array<FxTagRow>;
	commentCount: number;
};
type FxContributionRow = {
	kind: string;
	id: string;
	score: number;
	createdAt: string;
	bodyExcerpt: string | null;
	title: string | null;
	slug: string | null;
};
type FxProfileRow = {
	id: string;
	userId: string;
	username: string;
	totalKarma: number;
};

class FxCommentView extends FateDataView<FxCommentRow>()("FxComment")({
	id: true,
	parentId: true,
	author: true,
	body: true,
	score: true,
	createdAt: true,
}) {}

class FxPostView extends FateDataView<FxPostRow>()("FxPost")({
	id: true,
	slug: true,
	title: true,
	// pano's embedded-scalar shape: the pre-built tag array rides the row.
	tags: true,
	commentCount: true,
	comments: FateDataView.list(FxCommentView),
}) {}

class FxContributionView extends FateDataView<FxContributionRow>()("FxContribution")({
	kind: true,
	id: true,
	score: true,
	createdAt: true,
	bodyExcerpt: true,
	title: true,
	slug: true,
}) {}

class FxProfileView extends FateDataView<FxProfileRow>()("FxProfile")({
	id: true,
	userId: true,
	username: true,
	totalKarma: true,
	contributions: FateDataView.list(FxContributionView),
}) {}

class FxDb extends Context.Service<
	FxDb,
	{
		readonly posts: Array<FxPostRow>;
		readonly comments: Array<FxCommentRow>;
		readonly profiles: Array<FxProfileRow>;
		readonly contributions: Array<FxContributionRow>;
	}
>()("@phoenix/fate-effect/test/OracleFxDb") {}

/** A fresh feature world per backend (the comment mutation writes). */
const FxDbLive = Layer.sync(FxDb, () => ({
	posts: [
		{
			id: "p1",
			slug: "phoenix",
			title: "Phoenix Rises",
			tags: [
				{kind: "tech", label: "Tech"},
				{kind: "web", label: "Web"},
			],
			commentCount: 3,
		},
		{id: "p2", slug: "fate", title: "On fate", tags: [], commentCount: 0},
	],
	comments: [
		{
			id: "cm1",
			postId: "p1",
			parentId: null,
			author: "umut",
			body: "ilk yorum",
			score: 2,
			createdAt: "2026-01-01T00:00:00.000Z",
		},
		{
			id: "cm2",
			postId: "p1",
			parentId: "cm1",
			author: "ada",
			body: "cevap",
			score: 1,
			createdAt: "2026-01-02T00:00:00.000Z",
		},
		{
			id: "cm3",
			postId: "p1",
			parentId: null,
			author: "alan",
			body: "ikinci kök",
			score: 0,
			createdAt: "2026-01-03T00:00:00.000Z",
		},
	],
	profiles: [{id: "u1", userId: "u1", username: "umut", totalKarma: 42}],
	contributions: [
		{
			kind: "comment",
			id: "k3",
			score: 1,
			createdAt: "2026-02-03T00:00:00.000Z",
			bodyExcerpt: "cevap",
			title: null,
			slug: null,
		},
		{
			kind: "post",
			id: "k2",
			score: 5,
			createdAt: "2026-02-02T00:00:00.000Z",
			bodyExcerpt: null,
			title: "Phoenix Rises",
			slug: "phoenix",
		},
		{
			kind: "definition",
			id: "k1",
			score: 3,
			createdAt: "2026-02-01T00:00:00.000Z",
			bodyExcerpt: "bir efekt sistemi",
			title: null,
			slug: null,
		},
	],
}));

/**
 * The service-owned keyset window (ADR 0019's shape, `toConnection`'s exact
 * envelope: forward-only, `hasPrevious` always false, `nextCursor` only when
 * a next page exists). Identical code runs on both backends — what the
 * oracle pins is that DISPATCH carries args and cursors through unchanged.
 */
const fxKeyset = <Row extends {id: string}>(
	rows: ReadonlyArray<Row>,
	first: number,
	after: string | undefined,
): ConnectionResult<Row> => {
	const start = after === undefined ? 0 : rows.findIndex((row) => row.id === after) + 1;
	const window = rows.slice(start, start + first + 1);
	const page = window.slice(0, first);
	const last = page.at(-1);
	return {
		items: page.map((row) => ({cursor: row.id, node: row})),
		pagination: {
			hasNext: window.length > first,
			hasPrevious: false,
			...(window.length > first && last !== undefined ? {nextCursor: last.id} : {}),
		},
	};
};

/** The scoped nested-connection args shape the real features declare. */
const FxPageArgs = Schema.Struct({
	first: Schema.optional(Schema.Number),
	after: Schema.optional(Schema.String),
});

const fxQueries = {
	"fx.post": Fate.query(
		{
			args: Schema.Struct({slug: Schema.String, comments: Schema.optional(FxPageArgs)}),
			type: FxPostView,
		},
		Effect.fn("fx.post")(function* ({args, select}) {
			const db = yield* FxDb;
			const post = db.posts.find((row) => row.slug === args.slug) ?? null;
			if (post === null) {
				return null;
			}
			// The resolver OWNS the nested connection (pano/sozluk shape): only
			// attached when selected, paged by the service keyset.
			if (!hasNestedSelection(select, "comments")) {
				return post;
			}
			const page = args.comments;
			const comments = fxKeyset(
				db.comments.filter((row) => row.postId === post.id),
				page?.first ?? 2,
				page?.after,
			);
			return {...post, comments};
		}),
	),
	"fx.profile": Fate.query(
		{
			args: Schema.Struct({username: Schema.String, contributions: Schema.optional(FxPageArgs)}),
			type: FxProfileView,
		},
		Effect.fn("fx.profile")(function* ({args, select}) {
			const db = yield* FxDb;
			const profile = db.profiles.find((row) => row.username === args.username) ?? null;
			if (profile === null) {
				return null;
			}
			// pasaport's stamping: `id` === `userId` (the client normalization key).
			const base = {...profile, id: profile.userId};
			if (!hasNestedSelection(select, "contributions")) {
				return base;
			}
			const page = args.contributions;
			return {...base, contributions: fxKeyset(db.contributions, page?.first ?? 2, page?.after)};
		}),
	),
	// stats' shape: a string-typed query — no data view, no source demanded.
	"fx.landingStats": Fate.query(
		{type: "FxLandingStats"},
		Effect.fn("fx.landingStats")(function* () {
			const db = yield* FxDb;
			return {
				__typename: "FxLandingStats",
				id: "landing",
				totalPosts: db.posts.length,
				totalComments: db.comments.length,
				version: "v-test",
			};
		}),
	),
};

const fxLists = {
	"fx.posts": Fate.list(
		{args: FxPageArgs, type: FxPostView},
		Effect.fn("fx.posts")(function* ({args}) {
			const db = yield* FxDb;
			return fxKeyset(db.posts, args.first ?? 10, args.after);
		}),
	),
};

const fxMutations = {
	"fx.comment.add": Fate.mutation(
		{
			input: Schema.Struct({postId: Schema.String, body: Schema.String}),
			type: FxCommentView,
			error: Schema.Union([Unauthorized]),
		},
		Effect.fn("fx.comment.add")(function* ({input}) {
			const author = yield* CurrentUser.required;
			const db = yield* FxDb;
			const comment: FxCommentRow = {
				id: `cm-${db.comments.length + 1}`,
				postId: input.postId,
				parentId: null,
				author: author.id,
				body: input.body,
				score: 0,
				createdAt: "2026-03-01T00:00:00.000Z",
			};
			db.comments.push(comment);
			const live = yield* LivePublisher;
			yield* live
				.connection("FxPost.comments", {postId: input.postId})
				.appendNode("FxComment", comment.id, {node: comment});
			return comment;
		}),
	),
};

const fxPostSource = Fate.source(
	FxPostView,
	{id: "id"},
	{
		byIds: function* (ids) {
			const db = yield* FxDb;
			return db.posts.filter((row) => ids.includes(row.id));
		},
	},
);

const fxCommentSource = Fate.source(
	FxCommentView,
	{id: "id"},
	{
		byIds: function* (ids) {
			const db = yield* FxDb;
			return db.comments.filter((row) => ids.includes(row.id));
		},
	},
);

const fxProfileSource = Fate.source(
	FxProfileView,
	{id: "userId"},
	{
		byId: function* (id) {
			const db = yield* FxDb;
			const profile = db.profiles.find((row) => row.userId === id) ?? null;
			return profile === null ? null : {...profile, id: profile.userId};
		},
	},
);

/** pasaport's `Contribution`: capability-less BY DESIGN (the feed is
 * resolver-delivered; there is no standalone fetch path). */
const fxContributionSource: AnyFateSourceEntry = {
	typeName: "FxContribution",
	definition: {id: "id", view: FxContributionView.view},
	handlers: {},
};

const featureConfig = FateServer.config({
	queries: fxQueries,
	lists: fxLists,
	mutations: fxMutations,
	sources: [fxPostSource, fxCommentSource, fxProfileSource, fxContributionSource],
});

const makeFxV1 = (): OracleBackend => {
	const runtime = ManagedRuntime.make(
		FateServer.layer(featureConfig).pipe(Layer.provide(FxDbLive)),
	);
	return {
		handle: FateExecutor.toFetchHandler(runtime),
		dispose: () => runtime.dispose(),
	};
};

const makeFxV2 = (): OracleBackend => {
	const runtime = ManagedRuntime.make(
		FateServer.layer(featureConfig).pipe(Layer.provide(FxDbLive)),
	);
	return {
		handle: (request, context) =>
			runtime.runPromise(FateInterpreter.handleRequest(request, context)),
		dispose: () => runtime.dispose(),
	};
};

/** The walk-baseline arrangement (see `makeWalkV1`) over the feature config,
 * for the feature-shaped byId steps. */
const makeFxWalkV1 = async (): Promise<OracleBackend> => {
	const runtime = ManagedRuntime.make(
		FateServer.layer(featureConfig).pipe(Layer.provide(FxDbLive)),
	);
	const service = await runtime.runPromise(
		Effect.gen(function* () {
			return yield* FateServer;
		}),
	);
	const fxRoots = {
		fxPosts: list(FxPostView.view),
		fxProfiles: list(FxProfileView.view),
	};
	const server = createFateServer<
		FateRequestContext,
		typeof fxRoots,
		Record<never, never>,
		Record<never, never>,
		Record<never, never>,
		FateRequestContext
	>({
		context: ({adapterContext}) => {
			if (!adapterContext) {
				throw new Error("fx walk baseline: the harness always supplies the request context.");
			}
			return adapterContext;
		},
		roots: fxRoots,
		sources: compileFateSources(featureConfig.sources, {runtime, services: service.services}),
	});
	return {
		handle: (request, context) => server.handleRequest(request, context),
		dispose: () => runtime.dispose(),
	};
};

describe("the feature-shaped oracle corpus — pano / pasaport / stats", () => {
	it("named operations are byte-equal, cursor round-trips included", async () => {
		const umut = user("umut");
		const v1 = makeFxV1();
		const v2 = makeFxV2();
		try {
			// pano: the embedded-scalar tags array rides the post verbatim.
			await assertParity(v1, v2, {
				label: "post query without nested selection keeps tags scalar",
				operations: [
					{id: "1", kind: "query", name: "fx.post", args: {slug: "phoenix"}, select: []},
				],
			});
			await assertParity(v1, v2, {
				label: "post query miss yields null",
				operations: [{id: "1", kind: "query", name: "fx.post", args: {slug: "yok"}, select: []}],
			});
			// pano: the resolver-owned comments connection round-trips cursors.
			const commentsPageOne = await assertParity(v1, v2, {
				label: "post comments page 1",
				operations: [
					{
						id: "1",
						kind: "query",
						name: "fx.post",
						args: {slug: "phoenix", comments: {first: 2}},
						select: ["comments.body"],
					},
				],
			});
			const commentsCursor = JSON.parse(commentsPageOne.text).results[0].data.comments.pagination
				.nextCursor;
			expect(commentsCursor).toBe("cm2");
			const commentsPageTwo = await assertParity(v1, v2, {
				label: "post comments page 2 (after = page 1's nextCursor)",
				operations: [
					{
						id: "1",
						kind: "query",
						name: "fx.post",
						args: {slug: "phoenix", comments: {first: 2, after: commentsCursor}},
						select: ["comments.body"],
					},
				],
			});
			expect(JSON.parse(commentsPageTwo.text).results[0].data.comments.items).toHaveLength(1);
			// pano: the feed list keysets across pages.
			const feedPageOne = await assertParity(v1, v2, {
				label: "posts list page 1",
				operations: [{id: "1", kind: "list", name: "fx.posts", args: {first: 1}, select: []}],
			});
			const feedCursor = JSON.parse(feedPageOne.text).results[0].data.pagination.nextCursor;
			expect(feedCursor).toBe("p1");
			const feedPageTwo = await assertParity(v1, v2, {
				label: "posts list page 2 (after = page 1's nextCursor)",
				operations: [
					{
						id: "1",
						kind: "list",
						name: "fx.posts",
						args: {first: 1, after: feedCursor},
						select: [],
					},
				],
			});
			expect(JSON.parse(feedPageTwo.text).results[0].data.items[0].cursor).toBe("p2");
			// pano: the comment mutation — anonymous error, authed write + publish.
			await assertParity(v1, v2, {
				label: "anonymous comment.add is UNAUTHORIZED",
				operations: [
					{
						id: "1",
						kind: "mutation",
						name: "fx.comment.add",
						input: {postId: "p1", body: "yeni"},
						select: [],
					},
				],
			});
			await assertParity(v1, v2, {
				label: "comment.add writes and publishes",
				user: umut,
				operations: [
					{
						id: "1",
						kind: "mutation",
						name: "fx.comment.add",
						input: {postId: "p1", body: "yeni yorum"},
						select: [],
					},
				],
			});
			await assertParity(v1, v2, {
				label: "the write is visible to the NEXT request (state parity)",
				operations: [
					{
						id: "1",
						kind: "query",
						name: "fx.post",
						args: {slug: "phoenix", comments: {first: 10}},
						select: ["comments.body"],
					},
				],
			});
			// pano: invalid nested page args are the shared VALIDATION_ERROR.
			await assertParity(v1, v2, {
				label: "invalid nested page args are VALIDATION_ERROR",
				operations: [
					{
						id: "1",
						kind: "query",
						name: "fx.post",
						args: {slug: "phoenix", comments: {first: "x"}},
						select: ["comments.body"],
					},
				],
			});
			// pasaport: profile stamping + the contributions connection.
			await assertParity(v1, v2, {
				label: "profile query stamps id === userId",
				operations: [
					{id: "1", kind: "query", name: "fx.profile", args: {username: "umut"}, select: []},
				],
			});
			const contribPageOne = await assertParity(v1, v2, {
				label: "profile contributions page 1",
				operations: [
					{
						id: "1",
						kind: "query",
						name: "fx.profile",
						args: {username: "umut", contributions: {first: 2}},
						select: ["contributions.kind"],
					},
				],
			});
			const contribCursor = JSON.parse(contribPageOne.text).results[0].data.contributions.pagination
				.nextCursor;
			expect(contribCursor).toBe("k2");
			await assertParity(v1, v2, {
				label: "profile contributions page 2 (after = page 1's nextCursor)",
				operations: [
					{
						id: "1",
						kind: "query",
						name: "fx.profile",
						args: {username: "umut", contributions: {first: 2, after: contribCursor}},
						select: ["contributions.kind"],
					},
				],
			});
			await assertParity(v1, v2, {
				label: "profile miss yields null",
				operations: [
					{id: "1", kind: "query", name: "fx.profile", args: {username: "kimse"}, select: []},
				],
			});
			// stats: the plain string-typed query.
			await assertParity(v1, v2, {
				label: "landingStats parity (string-typed, no data view)",
				operations: [{id: "1", kind: "query", name: "fx.landingStats", select: []}],
			});
		} finally {
			await v1.dispose();
			await v2.dispose();
		}
	});

	it("feature-shaped byId operations are byte-equal against fate's walk", async () => {
		const v1 = await makeFxWalkV1();
		const v2 = makeFxV2();
		try {
			// pano: the embedded-scalar tags array passes the MASK verbatim too.
			await assertParity(v1, v2, {
				label: "post byId keeps the tags scalar through masking",
				operations: [
					{id: "1", kind: "byId", type: "FxPost", ids: ["p1"], select: ["title", "tags"]},
				],
			});
			// The walk never auto-fetches a resolver-owned connection: post rows
			// carry no `comments` key, so the selection masks to nothing — the
			// production semantic behind `.patterns/fate-connections.md`.
			await assertParity(v1, v2, {
				label: "selecting a resolver-owned connection on byId stays absent",
				operations: [
					{
						id: "1",
						kind: "byId",
						type: "FxPost",
						ids: ["p1"],
						select: ["title", "comments.body"],
					},
				],
			});
			// pasaport: the capability-less Contribution source is the internal arm.
			await assertParity(v1, v2, {
				label: "capability-less Contribution byId is fate's internal arm",
				operations: [
					{id: "1", kind: "byId", type: "FxContribution", ids: ["k1"], select: ["kind"]},
				],
			});
			// pasaport: the profile loads through its byId-only source.
			await assertParity(v1, v2, {
				label: "profile byId masks through the byId-only source",
				operations: [
					{
						id: "1",
						kind: "byId",
						type: "FxProfile",
						ids: ["u1"],
						select: ["username", "totalKarma"],
					},
				],
			});
		} finally {
			await v1.dispose();
			await v2.dispose();
		}
	});
});
