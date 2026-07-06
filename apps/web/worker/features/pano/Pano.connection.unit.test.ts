/**
 * Pano connection-resolver pagination DECISIONS, unit-reachable over the
 * substituted-`Drizzle` seam (ADR 0082 litmus: "could this be wrong even if the
 * database behaved perfectly?" → unit). `listPostsConnection`'s `first` clamp,
 * the single-direction keyset (all `desc`) whose lead column varies by sort, the
 * `id desc` tiebreak, the draft-exclusion predicate, and the cursor-miss →
 * empty-page branch are all wrong-or-right with no SQL engine — driven here over
 * a `Drizzle` double, never real D1.
 *
 * Two doubles, the `Vote.unit.test.ts` idiom:
 *   - `throwingAccess` — every `run` dies, so any path that actually reaches the
 *     DB seam fails the test (the cursor-miss-no-second-read proof).
 *   - `scriptedAccess` — replays a queued sequence of `run` results in call order
 *     (count, [cursor-resolve], fetch) AND captures the fetch builder's rendered
 *     SQL via `.toSQL()`, so the keyset predicate + `orderBy` + `LIMIT first+1`
 *     are asserted as the actual operators/columns, not a structural shape.
 *
 * Real-D1 keyset EXECUTION fidelity (collation, NULL tiebreaks, the paged walk)
 * stays integration-tier (`tests/integration/`), per ADR 0082's irreducible core.
 */
import {assert, describe, it} from "@effect/vitest";
import {drizzle} from "drizzle-orm/d1";
import {Effect, Layer} from "effect";
import {Drizzle, type DrizzleAccess, type DrizzleDb, relations} from "../../db/Drizzle.ts";
import {makePasaportStub, PasaportIdentityStub} from "../pasaport/Pasaport.testing.ts";
import type {Pasaport, ProfileIdentityRow} from "../pasaport/Pasaport.ts";
import {ReactionStub} from "../reaction/Reaction.testing.ts";
import {Vote} from "../vote/Vote.ts";
import {Bookmark} from "./Bookmark.ts";
import {Pano, PanoLive} from "./Pano.ts";

// A real drizzle/D1 client over a no-op D1 — used ONLY to run the fetch builder
// the resolver returns from `run`, so we can render its `.toSQL()`. It never
// executes (the scripted `run` resolves with queued rows, not the builder).
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
 * Replays `run` results in call order and records each call's rendered SQL when
 * the resolver's `fn` returns a renderable builder (the fetch). The count and
 * cursor-resolve calls chain `.get()/.then()` against the real `renderDb` (no-op
 * D1 → empty), so their queued value is what the resolver folds over; the fetch
 * call returns the builder directly, which we render and answer with rows.
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

// The fetch query is the LAST recorded one (count is first, cursor-resolve —
// when `after` is present — is between). On a head page it is `queries[1]`
// (count, fetch); with a cursor it is `queries[2]`.
const fetchQuery = (queries: {sql: string; params: unknown[]}[]) => queries.at(-1)!;

describe("Pano.listPostsConnection — `first` clamp [1,100] (no SQL engine booted)", () => {
	// The clamp surfaces as the `LIMIT first+1` param on the fetch query, so a
	// head page (count + fetch) is enough — no cursor read, no real engine.
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
		// count, cursor-resolve (the row), fetch.
		const {access, queries} = scriptedAccess([1, cursorRow, []]);
		return Effect.runPromise(sqlOf(sort).pipe(Effect.provide(panoLayer(access)))).then(() =>
			fetchQuery(queries),
		);
	};

	it("`top` → lead column `score` desc, then `id` desc", async () => {
		const {sql, params} = await run("top");
		assert.match(sql, /"post_record"\."score" < \?/, "score is the lead keyset column, desc → `<`");
		assert.match(sql, /order by "post_record"\."score" desc, "post_record"\."id" desc/);
		// keyset params: (score<v) or (score=v and id<v) → [5,5,"p9"], then LIMIT 11.
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
		// count → total, cursor-resolve → null (the miss). The fetch `run` would die
		// on `throwingAccess`, so reaching it fails the test. We compose: count +
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
		// No `after` → resolveCursor short-circuits to no-cursor: count + fetch only.
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
	// The keyset fetch projects exactly `PostKeysetRow` (post-fields.ts): the resolver
	// reads only these columns, so a scripted fetch row must carry the same subset.
	const fetchRow = {
		id: "post-1",
		slug: "baslik",
		title: "başlık",
		url: "https://kamp.us",
		host: "kamp.us",
		bodyExcerpt: "özet",
		authorId: "user-1",
		// The write-time snapshot — the STALE handle the pre-fix feed rendered.
		authorName: "eski-ad",
		score: 3,
		commentCount: 2,
		createdAt: new Date(1000),
		tags: "show",
	};

	// The LIVE `user_profile` identity for `user-1` — deliberately DIVERGENT from the
	// write-time `authorName` snapshot above, so a stamped row proves the feed read the
	// current handle rather than echoing the snapshot.
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
			// count + fetch (head page, no cursor). The fetch returns the one live row.
			const {access} = scriptedAccess([1 /* count */, [fetchRow] /* fetch */]);
			return Effect.gen(function* () {
				const pano = yield* Pano;
				const page = yield* pano.listPostsConnection({sort: "new", first: 10});
				assert.strictEqual(page.rows.length, 1, "head page returns the one row");
				const row = page.rows[0];
				assert.isDefined(row, "head page returns the one row");
				// The stamp — the fix's whole point: the resolver paths that DON'T re-hydrate
				// through `getPostsByIds` (landingPosts, signed-out posts) now get the live
				// identity here, so `actorLabel` renders the current display name.
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
				// The write-time `authorName` snapshot still rides as `author` (the intrinsic
				// field) — the stamp ADDS the live identity, it does not overwrite the snapshot.
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
			// Two posts by the same author collapse to one id in the batch.
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
