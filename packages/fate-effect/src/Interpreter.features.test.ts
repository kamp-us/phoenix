/**
 * `FateInterpreter` — the feature-shaped plane of the differential oracle:
 * the complete oracle corpus — every operation kind, every migrated
 * feature, success and error paths. The sozluk corpus
 * (`Interpreter.test.ts`, world in `Oracle.fixture.ts`) carries the
 * query/mutation taxonomy; this file adds the OTHER migrated features'
 * distinctive shapes at the level the oracle needs (in-memory, not D1):
 *
 *   - pano   — `tags` as an EMBEDDED SCALAR array on the post row (never a
 *              list relation), threaded comments as a resolver-owned inline
 *              keyset connection, a keyset-cursored feed list, and a
 *              publishing comment mutation.
 *   - pasaport — `profile` stamping `id` === `userId`, the resolver-owned
 *              `contributions` connection, and the CAPABILITY-LESS
 *              `Contribution` source (no byId/byIds/connection by design).
 *   - stats  — plain string-typed queries (`landingStats` has no data view).
 */
import type {ConnectionResult} from "@nkzw/fate/server";
import {createFateServer, hasNestedSelection, list} from "@nkzw/fate/server";
import {Context, Effect, Layer, ManagedRuntime} from "effect";
import * as Schema from "effect/Schema";
import {describe, expect, it} from "vitest";
import {CurrentUser, Unauthorized} from "./CurrentUser.ts";
import {FateDataView} from "./DataView.ts";
import {compileFateSources} from "./Executor.ts";
import {FateInterpreter} from "./Interpreter.ts";
import {Fate, FateExecutor} from "./index.ts";
import {LivePublisher} from "./LivePublisher.ts";
import {assertParity, type OracleBackend, user} from "./Oracle.fixture.ts";
import type {FateRequestContext} from "./RequestContext.ts";
import {FateServer} from "./Server.ts";

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
>()("@kampus/fate-effect/test/OracleFxDb") {}

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
				.topic("FxPost.comments", {postId: input.postId})
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
 * resolver-delivered; there is no standalone fetch path) — registered via
 * `Fate.syntheticSource`, whose loud failure the corpus pins on both planes. */
const fxContributionSource = Fate.syntheticSource(FxContributionView);

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

/** The walk-baseline arrangement (see `Interpreter.walk.test.ts`'s
 * `makeWalkV1`) over the feature config, for the feature-shaped byId steps. */
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
