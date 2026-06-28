/**
 * The by-id / batch-by-id draft-ownership gate (#1405, ADR 0113). `getPost` and
 * `getPostsByIds` must route the draft decision through the one PostVisibility seam
 * (`postVisibleTo` / `postVisibleWhere`), so a viewer holding a draft's id never reads
 * another author's unpublished draft while the author still reads their own
 * (read-your-writes). Two tiers, both unit-reachable over a substituted `Drizzle`:
 *
 *   - `getPost` decides in memory (relational query builder), so the leak case and
 *     read-your-writes are asserted as the actual returned value.
 *   - `getPostsByIds` decides in SQL, so the leak/own-draft behavior is the rendered
 *     `.toSQL()` predicate: the draft arm (`is_draft is not 1`) plus the signed-in
 *     ownership disjunction (`author_id = :viewerId`) the seam composes.
 */
import {assert, describe, it} from "@effect/vitest";
import {drizzle} from "drizzle-orm/d1";
import {Effect, Layer} from "effect";
import {Drizzle, type DrizzleAccess, type DrizzleDb, relations} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import {Vote} from "../vote/Vote.ts";
import {Bookmark} from "./Bookmark.ts";
import {Pano, PanoLive} from "./Pano.ts";

const AUTHOR = "the-author";
const OTHER = "someone-else";

// biome-ignore lint/plugin: a host D1 binding can't be structurally faked; the scripted `run` resolves queued values, so the no-op queries never execute — only `.toSQL()` rendering touches this.
const noopD1 = {
	prepare: () => ({
		bind() {
			return this;
		},
		async all() {
			return {results: []};
		},
		async first() {
			return null;
		},
		async run() {
			return {};
		},
		async raw() {
			return [];
		},
	}),
	async batch() {
		return [];
	},
} as unknown as D1Database;
const renderDb = drizzle(noopD1, {schema, relations});

const hasToSQL = (v: unknown): v is {toSQL: () => {sql: string; params: unknown[]}} =>
	typeof v === "object" && v !== null && typeof (v as {toSQL?: unknown}).toSQL === "function";

function scriptedAccess(results: ReadonlyArray<unknown>): {
	access: DrizzleAccess;
	queries: {sql: string; params: unknown[]}[];
} {
	const state = {i: 0};
	const queries: {sql: string; params: unknown[]}[] = [];
	const access: DrizzleAccess = {
		run: <A>(fn: (db: DrizzleDb) => Promise<A>) => {
			const built = fn(renderDb) as unknown;
			if (hasToSQL(built)) queries.push(built.toSQL());
			return Effect.succeed(results[state.i++] as A);
		},
		batch: () => Effect.die(new Error("by-id reads must not batch")),
	};
	return {access, queries};
}

// biome-ignore lint/plugin: a service double — the by-id reads only reach `readMine`.
const VoteStub = Layer.succeed(Vote, {
	cast: () => Effect.die(new Error("by-id reads must not cast a vote")),
	readMine: () => Effect.succeed(new Set<string>()),
	clearTarget: () => Effect.void,
} as unknown as typeof Vote.Service);

// biome-ignore lint/plugin: a service double — only `readMine` is on this path.
const BookmarkStub = Layer.succeed(Bookmark, {
	toggle: () => Effect.die(new Error("by-id reads must not toggle a bookmark")),
	readMine: () => Effect.succeed(new Set<string>()),
	listSavedConnection: () => Effect.die(new Error("not used")),
} as unknown as typeof Bookmark.Service);

const panoLayer = (access: DrizzleAccess) =>
	PanoLive.pipe(
		Layer.provide(VoteStub),
		Layer.provide(BookmarkStub),
		Layer.provide(Layer.succeed(Drizzle, access)),
	);

const now = new Date("2026-06-27T00:00:00.000Z");

// A live (not removed, not sandboxed) draft `post_record` authored by AUTHOR.
// biome-ignore lint/plugin: a row fixture standing in for a `post_record` select — getPost only reads the lifecycle/draft/author columns + the `toPostPage` field set off it; enumerating every column adds nothing.
const draftRow = {
	id: "post_draft1",
	slug: null,
	title: "wip",
	url: null,
	host: null,
	body: "half-written",
	bodyExcerpt: "half-written",
	authorId: AUTHOR,
	authorName: "Author",
	tags: "",
	score: 0,
	commentCount: 0,
	hotScore: 0,
	createdAt: now,
	updatedAt: now,
	lastActivityAt: now,
	removedAt: null,
	removedBy: null,
	removedReason: null,
	sandboxedAt: null,
	isDraft: true,
} as unknown as typeof schema.postRecord.$inferSelect;

describe("Pano.getPost — draft is author-only (the by-id leak gate, #1405)", () => {
	it.effect("a non-owner by-id read of a draft resolves not-found (the leak case)", () =>
		Effect.gen(function* () {
			const pano = yield* Pano;
			const got = yield* pano.getPost(draftRow.id, {viewerId: OTHER});
			assert.isNull(got, "another author's draft must not disclose to a viewer holding its id");
		}).pipe(Effect.provide(panoLayer(scriptedAccess([draftRow]).access))),
	);

	it.effect("the author reads their OWN draft by id (read-your-writes)", () =>
		Effect.gen(function* () {
			const pano = yield* Pano;
			const got = yield* pano.getPost(draftRow.id, {viewerId: AUTHOR});
			assert.isNotNull(got, "the author must read their own draft back");
			assert.strictEqual(got?.id, draftRow.id);
		}).pipe(Effect.provide(panoLayer(scriptedAccess([draftRow]).access))),
	);

	it.effect("an anonymous by-id read of a draft resolves not-found", () =>
		Effect.gen(function* () {
			const pano = yield* Pano;
			const got = yield* pano.getPost(draftRow.id, {});
			assert.isNull(got);
		}).pipe(Effect.provide(panoLayer(scriptedAccess([draftRow]).access))),
	);
});

describe("Pano.getPostsByIds — batch routes through the seam's draft arm (#1405)", () => {
	it.effect(
		"a signed-in batch read gates drafts AND keeps the viewer's own (ownership disjunction)",
		() => {
			const {access, queries} = scriptedAccess([[] /* fetched */]);
			return Effect.gen(function* () {
				const pano = yield* Pano;
				yield* pano.getPostsByIds([draftRow.id], {viewerId: OTHER});
				const {sql, params} = queries[0]!;
				assert.match(sql, /"post_record"\."is_draft" is not 1/, "draft arm from the seam");
				assert.match(
					sql,
					/"post_record"\."author_id" = \?/,
					"signed-in viewer keeps their OWN drafts via the ownership disjunction",
				);
				assert.include(params, OTHER, "the ownership arm is bound to the viewer");
			}).pipe(Effect.provide(panoLayer(access)));
		},
	);

	it.effect("an anonymous batch read gates drafts with no ownership escape hatch", () => {
		const {access, queries} = scriptedAccess([[] /* fetched */]);
		return Effect.gen(function* () {
			const pano = yield* Pano;
			yield* pano.getPostsByIds([draftRow.id], {});
			const {sql} = queries[0]!;
			assert.match(
				sql,
				/"post_record"\."is_draft" is not 1/,
				"draft arm gates the anonymous batch",
			);
			assert.notMatch(
				sql,
				/"post_record"\."author_id" = \?/,
				"anonymous viewer has no ownership disjunction — public drafts never disclose",
			);
		}).pipe(Effect.provide(panoLayer(access)));
	});
});
