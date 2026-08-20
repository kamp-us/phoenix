/**
 * The by-id / batch-by-id draft-ownership gate (ADR 0113): a viewer holding a draft's
 * id must never read another author's unpublished draft, while the author still reads
 * their own.
 *
 * `getPost` decides in memory, so it is asserted on the returned value; `getPostsByIds`
 * decides in SQL, so it is asserted on the rendered `.toSQL()` predicate.
 */
import {assert, describe, it} from "@effect/vitest";
import {drizzle} from "drizzle-orm/d1";
import {Effect, Layer} from "effect";
import {Drizzle, type DrizzleAccess, type DrizzleDb, relations} from "../../db/Drizzle.ts";
import type * as schema from "../../db/drizzle/schema.ts";
import {memberSandboxViewer} from "../kunye/sandbox.testing.ts";
import {anonymousViewer} from "../lifecycle/EntityLifecycle.ts";
import {PasaportIdentityStub} from "../pasaport/Pasaport.testing.ts";
import {ReactionStub} from "../reaction/Reaction.testing.ts";
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
const renderDb = drizzle(noopD1, {relations});

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
		Layer.provide(ReactionStub),
		Layer.provide(PasaportIdentityStub),
		Layer.provide(Layer.succeed(Drizzle, access)),
	);

const now = new Date("2026-06-27T00:00:00.000Z");

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
			const got = yield* pano.getPost(draftRow.id, {
				viewerId: OTHER,
				sandboxViewer: memberSandboxViewer(OTHER),
			});
			assert.isNull(got, "another author's draft must not disclose to a viewer holding its id");
		}).pipe(Effect.provide(panoLayer(scriptedAccess([draftRow]).access))),
	);

	it.effect("the author reads their OWN draft by id (read-your-writes)", () =>
		Effect.gen(function* () {
			const pano = yield* Pano;
			const got = yield* pano.getPost(draftRow.id, {
				viewerId: AUTHOR,
				sandboxViewer: memberSandboxViewer(AUTHOR),
			});
			assert.isNotNull(got, "the author must read their own draft back");
			assert.strictEqual(got?.id, draftRow.id);
		}).pipe(Effect.provide(panoLayer(scriptedAccess([draftRow]).access))),
	);

	it.effect("an anonymous by-id read of a draft resolves not-found", () =>
		Effect.gen(function* () {
			const pano = yield* Pano;
			const got = yield* pano.getPost(draftRow.id, {sandboxViewer: anonymousViewer});
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
				yield* pano.getPostsByIds([draftRow.id], {
					viewerId: OTHER,
					sandboxViewer: memberSandboxViewer(OTHER),
				});
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
			yield* pano.getPostsByIds([draftRow.id], {sandboxViewer: anonymousViewer});
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
