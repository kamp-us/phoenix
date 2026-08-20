/**
 * Pano connection-resolver pagination decisions over a substituted `Drizzle` seam, never
 * real D1 (ADR 0082). Two doubles: `throwingAccess` (every `run` dies, so any path that
 * reaches the DB seam fails the test) and `scriptedAccess` (replays queued `run` results
 * in call order and captures the fetch builder's rendered SQL via `.toSQL()`).
 *
 * Real-D1 keyset EXECUTION fidelity stays integration-tier, per ADR 0082.
 */
import {assert, describe, it} from "@effect/vitest";
import {drizzle} from "drizzle-orm/d1";
import {Effect, Layer} from "effect";
import {Drizzle, type DrizzleAccess, type DrizzleDb, relations} from "../../db/Drizzle.ts";
import type * as schema from "../../db/drizzle/schema.ts";
import {makePasaportStub, PasaportIdentityStub} from "../pasaport/Pasaport.testing.ts";
import type {Pasaport, ProfileIdentityRow} from "../pasaport/Pasaport.ts";
import {ReactionStub} from "../reaction/Reaction.testing.ts";
import {Reaction, type ReactionAggregate} from "../reaction/Reaction.ts";
import {Vote} from "../vote/Vote.ts";
import {Bookmark} from "./Bookmark.ts";
import {Pano, PanoLive} from "./Pano.ts";

// A real drizzle/D1 client over a no-op D1 — used ONLY to render the fetch builder's
// `.toSQL()`. It never executes (the scripted `run` resolves with queued rows).
// biome-ignore lint/plugin: `D1Database` is a host binding that can't be structurally constructed in a fake; only `prepare`/`batch` are exercised, and the scripted `run` never lets the no-op queries execute.
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

/**
 * Replays `run` results in call order and records each call's rendered SQL when the
 * resolver's `fn` returns a renderable builder (the fetch).
 */
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
			const value = results[state.i++] as A;
			return Effect.succeed(value);
		},
		batch: () => Effect.die(new Error("listPostsConnection must not batch")),
	};
	return {access, queries};
}

// biome-ignore lint/plugin: a service double — `Vote.Service` carries methods the connection resolver never reaches (the stubbed `readMine` is the only one on this path); structurally constructing the full interface adds nothing.
const VoteStub = Layer.succeed(Vote, {
	cast: () => Effect.die(new Error("listPostsConnection must not cast a vote")),
	readMine: () => Effect.succeed(new Set<string>()),
	clearTarget: () => Effect.void,
} as unknown as typeof Vote.Service);

// biome-ignore lint/plugin: a service double — `Bookmark.Service` methods are unreached by the connection resolver under test.
const BookmarkStub = Layer.succeed(Bookmark, {
	toggle: () => Effect.die(new Error("listPostsConnection must not toggle a bookmark")),
	readMine: () => Effect.succeed(new Set<string>()),
	listSavedConnection: () => Effect.die(new Error("not used")),
} as unknown as typeof Bookmark.Service);

const panoLayer = (access: DrizzleAccess, pasaport: Layer.Layer<Pasaport> = PasaportIdentityStub) =>
	PanoLive.pipe(
		Layer.provide(VoteStub),
		Layer.provide(BookmarkStub),
		Layer.provide(ReactionStub),
		Layer.provide(pasaport),
		Layer.provide(Layer.succeed(Drizzle, access)),
	);

// The fetch query is the LAST recorded one (count is first, cursor-resolve — when `after`
// is present — is between).
const fetchQuery = (queries: {sql: string; params: unknown[]}[]) => queries.at(-1)!;

describe("Pano.listPostsConnection — `first` clamp [1,100] (no SQL engine booted)", () => {
	const clampCase = (input: number | undefined, expectedLimit: number) =>
		it.effect(`first=${String(input)} → LIMIT ${expectedLimit}`, () => {
			const {access, queries} = scriptedAccess([0 /* count */, [] /* fetch */]);
			return Effect.gen(function* () {
				const pano = yield* Pano;
				yield* pano.listPostsConnection(input === undefined ? {} : {first: input});
				const {params} = fetchQuery(queries);
				assert.strictEqual(
					params.at(-1),
					expectedLimit,
					"LIMIT is the clamped first + 1 (the probe row)",
				);
			}).pipe(Effect.provide(panoLayer(access)));
		});

	clampCase(0, 2); // below min → clamped to 1, +1 probe
	clampCase(-5, 2); // negative → clamped to 1
	clampCase(500, 101); // above max → clamped to 100, +1 probe
	clampCase(undefined, 21); // default 20, +1 probe
	clampCase(50, 51); // in-range passes through
});

describe("Pano.listPostsConnection — single-direction keyset, lead column by sort", () => {
	// A resolved cursor row so the keyset predicate is built (not a head page).
	const cursorRow = {id: "p9", score: 5, hotScore: 7, commentCount: 3, createdAt: null};

	const sqlOf = (sort: "hot" | "new" | "top" | "discuss") =>
		Effect.gen(function* () {
			const pano = yield* Pano;
			yield* pano.listPostsConnection({sort, first: 10, after: "p9"});
		});

	const run = (sort: "hot" | "new" | "top" | "discuss") => {
		const {access, queries} = scriptedAccess([1, cursorRow, []]);
		return Effect.runPromise(sqlOf(sort).pipe(Effect.provide(panoLayer(access)))).then(() =>
			fetchQuery(queries),
		);
	};

	it("`top` → lead column `score` desc, then `id` desc", async () => {
		const {sql, params} = await run("top");
		assert.match(sql, /"post_record"\."score" < \?/, "score is the lead keyset column, desc → `<`");
		assert.match(sql, /order by "post_record"\."score" desc, "post_record"\."id" desc/);
		assert.deepStrictEqual(params, [5, 5, "p9", 11]);
	});

	it("`discuss` → lead column `comment_count` desc", async () => {
		const {sql, params} = await run("discuss");
		assert.match(sql, /"post_record"\."comment_count" < \?/);
		assert.match(sql, /order by "post_record"\."comment_count" desc, "post_record"\."id" desc/);
		assert.deepStrictEqual(params, [3, 3, "p9", 11]);
	});

	it("default `hot` → lead column `hot_score` desc", async () => {
		const {sql, params} = await run("hot");
		assert.match(sql, /"post_record"\."hot_score" < \?/);
		assert.match(sql, /order by "post_record"\."hot_score" desc, "post_record"\."id" desc/);
		assert.deepStrictEqual(params, [7, 7, "p9", 11]);
	});

	it("`new` → NO lead column, `id` desc alone (bare `<`, no disjunction)", async () => {
		const {sql, params} = await run("new");
		assert.match(sql, /"post_record"\."id" < \?/, "id-only keyset is a bare `<`");
		assert.notMatch(sql, / or /, "no lead column → no lexicographic disjunction");
		assert.match(sql, /order by "post_record"\."id" desc/);
		assert.notMatch(sql, /order by.*,/, "single ordering column");
		assert.deepStrictEqual(params, ["p9", 11]);
	});

	it("every sort excludes drafts (`is_draft is not 1`) and live rows (`removed_at is null`)", async () => {
		for (const sort of ["hot", "new", "top", "discuss"] as const) {
			const {sql} = await run(sort);
			assert.match(sql, /"post_record"\."is_draft" is not 1/, `${sort}: draft-exclusion predicate`);
			assert.match(sql, /"post_record"\."removed_at" is null/, `${sort}: live-only predicate`);
		}
	});
});

describe("Pano.listPostsConnection — cursor-miss → empty page, NO second DB read", () => {
	it.effect("present `after` resolving to no row → empty page; throwing seam never dies", () => {
		// The fetch `run` would die on `throwingAccess`, so reaching it fails the test: count +
		// cursor-resolve are scripted, the fetch seam throws.
		let i = 0;
		const access: DrizzleAccess = {
			run: <A>(fn: (db: DrizzleDb) => Promise<A>) => {
				void fn;
				if (i === 0) {
					i++;
					return Effect.succeed(7 as A); // count
				}
				if (i === 1) {
					i++;
					return Effect.succeed(null as A); // cursor-resolve → no row (miss)
				}
				return Effect.die(new Error("cursor miss must not read the DB a third time (the fetch)"));
			},
			batch: () => Effect.die(new Error("must not batch")),
		};
		return Effect.gen(function* () {
			const pano = yield* Pano;
			const page = yield* pano.listPostsConnection({first: 10, after: "ghost"});
			assert.deepStrictEqual(page.rows, [], "miss → no rows");
			assert.strictEqual(page.hasNextPage, false, "miss → no next page");
			assert.strictEqual(page.endCursor, null, "miss → no cursor");
			assert.strictEqual(page.totalCount, 7, "miss still reports the total it already read");
		}).pipe(Effect.provide(panoLayer(access)));
	});

	it.effect("a head page (no `after`) never reads a cursor row", () => {
		// Inject a marker after two calls so a stray cursor-resolve read would die.
		let i = 0;
		const {access: scripted} = scriptedAccess([0, []]);
		const access: DrizzleAccess = {
			run: <A>(fn: (db: DrizzleDb) => Promise<A>) => {
				if (i++ >= 2)
					return Effect.die(new Error("head page must not resolve a cursor (no third read)"));
				return scripted.run(fn);
			},
			batch: scripted.batch,
		};
		return Effect.gen(function* () {
			const pano = yield* Pano;
			const page = yield* pano.listPostsConnection({first: 10});
			assert.strictEqual(page.totalCount, 0);
		}).pipe(Effect.provide(panoLayer(access)));
	});
});

describe("Pano.listPostsConnection — stamps the LIVE author identity on the page (#2151)", () => {
	const fetchRow = {
		id: "post-1",
		slug: "baslik",
		title: "başlık",
		url: "https://kamp.us",
		host: "kamp.us",
		bodyExcerpt: "özet",
		authorId: "user-1",
		authorName: "eski-ad",
		score: 3,
		commentCount: 2,
		createdAt: new Date(1000),
		tags: "show",
	};

	// Deliberately DIVERGENT from the write-time `authorName` snapshot above, so a stamped
	// row proves the feed read the current handle rather than echoing the snapshot.
	const liveIdentity: ProfileIdentityRow = {
		userId: "user-1",
		username: "umut",
		displayName: "Umut Şirin",
		totalKarma: 42,
	};

	const readSpy: {ids: ReadonlyArray<string> | null} = {ids: null};
	const LiveIdentityStub = makePasaportStub({
		getProfileIdentitiesByIds: (ids: ReadonlyArray<string>) => {
			readSpy.ids = ids;
			return Effect.succeed([liveIdentity]);
		},
	});

	it.effect(
		"landingPosts / signed-out feed path: the page row carries the LIVE username + displayName, not the write-time snapshot",
		() => {
			readSpy.ids = null;
			const {access} = scriptedAccess([1 /* count */, [fetchRow] /* fetch */]);
			return Effect.gen(function* () {
				const pano = yield* Pano;
				const page = yield* pano.listPostsConnection({sort: "new", first: 10});
				assert.strictEqual(page.rows.length, 1, "head page returns the one row");
				const row = page.rows[0];
				assert.isDefined(row, "head page returns the one row");
				// The resolver paths that DON'T re-hydrate through `getPostsByIds` get the live
				// identity here.
				assert.strictEqual(
					row.authorDisplayName,
					"Umut Şirin",
					"the live displayName is stamped onto the feed row",
				);
				assert.strictEqual(
					row.authorUsername,
					"umut",
					"the live username is stamped onto the feed row",
				);
				// The stamp ADDS the live identity; it does not overwrite the write-time snapshot.
				assert.strictEqual(
					row.author,
					"eski-ad",
					"the write-time snapshot is preserved as `author`",
				);
			}).pipe(Effect.provide(panoLayer(access, LiveIdentityStub)));
		},
	);

	it.effect("the identity read is ONE batched query keyed by the page's authorIds — no N+1", () => {
		readSpy.ids = null;
		const rows = [
			{...fetchRow, id: "post-1", authorId: "user-1"},
			{...fetchRow, id: "post-2", authorId: "user-2"},
			{...fetchRow, id: "post-3", authorId: "user-1"},
		];
		const {access} = scriptedAccess([3 /* count */, rows /* fetch */]);
		return Effect.gen(function* () {
			const pano = yield* Pano;
			yield* pano.listPostsConnection({sort: "new", first: 10});
			assert.deepStrictEqual(
				[...(readSpy.ids ?? [])].sort(),
				["user-1", "user-2"],
				"one identity read over the page's DISTINCT authorIds — never per-row",
			);
		}).pipe(Effect.provide(panoLayer(access, LiveIdentityStub)));
	});
});

describe("Pano — authed feed: parallelized listPostsConnection composes with the getPostsByIds re-hydrate (#2275)", () => {
	// The per-viewer scalars (`myVote`/`isSaved`) and the reaction aggregate are NOT read
	// inside `listPostsConnection` — they come from the batched `getPostsByIds` re-hydrate
	// the `posts` resolver runs for a signed-in viewer.
	const VIEWER = "user-viewer";

	const keysetRow = {
		id: "post-1",
		slug: "baslik",
		title: "başlık",
		url: "https://kamp.us",
		host: "kamp.us",
		bodyExcerpt: "özet",
		authorId: "user-1",
		authorName: "eski-ad",
		score: 3,
		commentCount: 2,
		createdAt: new Date(1000),
		tags: "show",
	};

	// biome-ignore lint/plugin: a row fixture standing in for a full `post_record` select; getPostsByIds reads the lifecycle/draft columns + the `toPostSummaryRow` field set off it, enumerating every column adds nothing.
	const fullRecord = {
		id: "post-1",
		slug: "baslik",
		title: "başlık",
		url: "https://kamp.us",
		host: "kamp.us",
		body: "gövde",
		bodyExcerpt: "özet",
		authorId: "user-1",
		authorName: "eski-ad",
		tags: "show",
		score: 3,
		commentCount: 2,
		hotScore: 5,
		createdAt: new Date(1000),
		updatedAt: new Date(1000),
		lastActivityAt: new Date(1000),
		removedAt: null,
		removedBy: null,
		removedReason: null,
		sandboxedAt: null,
		isDraft: null,
	} as unknown as typeof schema.postRecord.$inferSelect;

	const reactionAggregate: ReactionAggregate = {
		counts: [{emoji: "🔥", count: 4}],
		myReaction: "🔥",
	};

	// biome-ignore lint/plugin: a service double — only `readMine` is on the re-hydrate path.
	const VotedStub = Layer.succeed(Vote, {
		cast: () => Effect.die(new Error("feed re-hydrate must not cast a vote")),
		readMine: () => Effect.succeed(new Set<string>(["post-1"])),
		clearTarget: () => Effect.void,
	} as unknown as typeof Vote.Service);

	// biome-ignore lint/plugin: a service double — only `readMine` is on the re-hydrate path.
	const SavedStub = Layer.succeed(Bookmark, {
		toggle: () => Effect.die(new Error("feed re-hydrate must not toggle a bookmark")),
		readMine: () => Effect.succeed(new Set<string>(["post-1"])),
		listSavedConnection: () => Effect.die(new Error("not used")),
	} as unknown as typeof Bookmark.Service);

	const ReactedStub = Layer.succeed(Reaction, {
		react: () => Effect.die(new Error("feed re-hydrate must not react")),
		readMine: () => Effect.die(new Error("readMine not on this path")),
		readAggregate: () => Effect.succeed(new Map([["post-1", reactionAggregate]])),
		clearTarget: () => Effect.void,
	} satisfies typeof Reaction.Service);

	const authedPanoLayer = (access: DrizzleAccess) =>
		PanoLive.pipe(
			Layer.provide(VotedStub),
			Layer.provide(SavedStub),
			Layer.provide(ReactedStub),
			Layer.provide(PasaportIdentityStub),
			Layer.provide(Layer.succeed(Drizzle, access)),
		);

	it.effect(
		"a signed-in viewer with a vote + a save + a reaction sees all three on the composed feed row",
		() => {
			const {access} = scriptedAccess([
				1 /* count */,
				[keysetRow] /* keyset page fetch */,
				[fullRecord] /* getPostsByIds re-hydrate fetch */,
			]);
			return Effect.gen(function* () {
				const pano = yield* Pano;
				const page = yield* pano.listPostsConnection({sort: "new", first: 10});
				assert.strictEqual(page.totalCount, 1, "parallelized count still lands on the page");
				const ids = page.rows.map((row) => row.id);
				assert.deepStrictEqual(ids, ["post-1"], "the keyset page carries the id to re-hydrate");

				const hydrated = yield* pano.getPostsByIds(ids, {viewerId: VIEWER});
				const row = hydrated[0];
				assert.isDefined(row, "the re-hydrate returns the viewer-scoped row");
				assert.strictEqual(row.myVote, true, "the viewer's vote survives the re-hydrate stamp");
				assert.strictEqual(row.isSaved, true, "the viewer's save survives the re-hydrate stamp");
				assert.deepStrictEqual(
					row.reactions,
					reactionAggregate,
					"the reaction aggregate survives the re-hydrate stamp",
				);
			}).pipe(Effect.provide(authedPanoLayer(access)));
		},
	);
});

// Mute read-mask (#3113): the muted-author SQL arm is `and()`ed into the pano feed +
// thread fetch — present-with-mute emits `author_id not in (…)`, absent/off emits nothing.
describe("Pano feed + thread — mute read-mask (author_id NOT IN …)", () => {
	it.effect("listPostsConnection masks a muted author when `mutedIds` is non-empty", () => {
		const {access, queries} = scriptedAccess([1 /* count */, [] /* fetch */]);
		return Effect.gen(function* () {
			const pano = yield* Pano;
			yield* pano.listPostsConnection({sort: "new", first: 10, mutedIds: new Set(["u-muted"])});
			const {sql, params} = fetchQuery(queries);
			assert.match(sql, /"post_record"\."author_id" not in \(\?\)/, "muted author excluded");
			assert.include(params, "u-muted");
		}).pipe(Effect.provide(panoLayer(access)));
	});

	it.effect("listPostsConnection is unchanged with no `mutedIds` (no NOT IN clause)", () => {
		const {access, queries} = scriptedAccess([1 /* count */, [] /* fetch */]);
		return Effect.gen(function* () {
			const pano = yield* Pano;
			yield* pano.listPostsConnection({sort: "new", first: 10});
			assert.notMatch(fetchQuery(queries).sql, /not in/, "no mask ⇒ byte-for-byte today's feed");
		}).pipe(Effect.provide(panoLayer(access)));
	});

	it.effect("listCommentsKeyset masks a muted author when `mutedIds` is non-empty", () => {
		const {access, queries} = scriptedAccess([0 /* count */, [] /* fetch */]);
		return Effect.gen(function* () {
			const pano = yield* Pano;
			yield* pano.listCommentsKeyset("post-1", {first: 10, mutedIds: new Set(["u-muted"])});
			const {sql, params} = fetchQuery(queries);
			assert.match(sql, /"comment_record"\."author_id" not in \(\?\)/, "muted author excluded");
			assert.include(params, "u-muted");
		}).pipe(Effect.provide(panoLayer(access)));
	});

	it.effect("listCommentsKeyset is unchanged with no `mutedIds` (no NOT IN clause)", () => {
		const {access, queries} = scriptedAccess([0 /* count */, [] /* fetch */]);
		return Effect.gen(function* () {
			const pano = yield* Pano;
			yield* pano.listCommentsKeyset("post-1", {first: 10});
			assert.notMatch(fetchQuery(queries).sql, /not in/, "no mask ⇒ byte-for-byte today's thread");
		}).pipe(Effect.provide(panoLayer(access)));
	});
});
