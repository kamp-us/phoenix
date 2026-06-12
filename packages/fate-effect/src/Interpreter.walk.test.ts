/**
 * `FateInterpreter` — the WALK plane of the differential oracle: byId
 * operations + nested ref selections, byte-equal against fate's own walk.
 *
 * The dual-stack harness (`assertParity` and friends) comes from
 * `Oracle.fixture.ts`; the walk corpus gets its OWN entity family
 * (books/authors) over static in-memory tables, declared here — byId
 * operations never mutate, so no per-backend database service is needed and
 * the shared sozluk world stays untouched. byId rides the selection walk
 * with its connection plane: scoped pagination args, in-array windowing,
 * cursor round-trips across pages.
 */
import type {ConnectionResult, FieldSelection} from "@nkzw/fate/server";
import {
	computed,
	createFateServer,
	FateRequestError,
	field,
	list,
	resolver,
} from "@nkzw/fate/server";
import {Effect, ManagedRuntime} from "effect";
import {describe, expect, it} from "vitest";
import {FateDataView} from "./DataView.ts";
import {compileFateSources} from "./Executor.ts";
import {FateInterpreter} from "./Interpreter.ts";
import {Fate} from "./index.ts";
import {
	assertParity,
	type OracleBackend,
	type OracleObservation,
	type OracleStep,
	user,
} from "./Oracle.fixture.ts";
import type {FateRequestContext} from "./RequestContext.ts";
import {FateServer} from "./Server.ts";

// --- the walk fixtures (byId + nested refs over static tables) --------------------

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

/** Capability-less (the `contributionSource` shape — `Fate.syntheticSource`,
 * the package's synthetic-entity escape hatch): any load is fate's internal
 * arm, parity-pinned below on both planes — the loud-failure contract. */
const walkGhostSource = Fate.syntheticSource(WalkGhostView);

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
			// -- the connection plane: raw arrays under list-kind fields --
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
		// The keyset-lockstep contract (ADR 0019 discipline at the oracle level): page
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
