/**
 * Sözlük connection-resolver pagination DECISIONS, unit-reachable over the
 * substituted-`Drizzle` seam (ADR 0082 litmus: "could this be wrong even if the
 * database behaved perfectly?" → unit). Two resolvers, both pure above the
 * cursor-read port:
 *
 *   - `listDefinitionsKeyset` — the `first` clamp `[1,200]`, the MIXED-direction
 *     keyset tuple (`score desc, created_at asc, id asc`), the cursor-miss →
 *     empty-page branch, the page envelope. The `id` cursor value is the opaque
 *     `after` itself (the resolved row carries only `score`/`created_at`).
 *   - `listTermSummariesConnection` — the `first` clamp `[1,100]`.
 *
 * Doubles follow `Vote.unit.test.ts`: a `scriptedAccess` that replays `run`
 * results in call order and renders the fetch builder's `.toSQL()`, and a
 * fetch-seam-throws composition that proves the cursor miss takes no further
 * read. Real-D1 keyset EXECUTION (collation, NULL tiebreaks, the paged walk)
 * stays integration-tier per ADR 0082's irreducible core.
 */
import {assert, describe, it} from "@effect/vitest";
import {drizzle} from "drizzle-orm/d1";
import {Effect, Layer} from "effect";
import {Drizzle, type DrizzleAccess, type DrizzleDb, relations} from "../../db/Drizzle.ts";
import {PasaportIdentityStub} from "../pasaport/Pasaport.testing.ts";
import {ReactionStub} from "../reaction/Reaction.testing.ts";
import {Vote} from "../vote/Vote.ts";
import {Sozluk, SozlukLive} from "./Sozluk.ts";

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
		batch: () => Effect.die(new Error("connection resolver must not batch")),
	};
	return {access, queries};
}

// `listDefinitionsKeyset` finalizes the page through `stampViewerScalars`, which
// reads `Vote.readMine`; the stub returns an empty Set so no `myVote` is stamped
// and no extra DB read happens through the vote service.
// biome-ignore lint/plugin: a service double — `Vote.Service` carries methods the connection resolver never reaches (only the stubbed `readMine` is on this path).
const VoteStub = Layer.succeed(Vote, {
	cast: () => Effect.die(new Error("connection resolver must not cast a vote")),
	readMine: () => Effect.succeed(new Set<string>()),
	clearTarget: () => Effect.void,
} as unknown as typeof Vote.Service);

const sozlukLayer = (access: DrizzleAccess) =>
	SozlukLive.pipe(
		Layer.provide(VoteStub),
		Layer.provide(ReactionStub),
		Layer.provide(PasaportIdentityStub),
		Layer.provide(Layer.succeed(Drizzle, access)),
	);

const fetchQuery = (queries: {sql: string; params: unknown[]}[]) => queries.at(-1)!;

describe("Sozluk.listDefinitionsKeyset — `first` clamp [1,200] (no SQL engine booted)", () => {
	const clampCase = (input: number | undefined, expectedLimit: number) =>
		it.effect(`first=${String(input)} → LIMIT ${expectedLimit}`, () => {
			const {access, queries} = scriptedAccess([0 /* count */, [] /* fetch */]);
			return Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				yield* sozluk.listDefinitionsKeyset("a-term", {first: input});
				assert.strictEqual(fetchQuery(queries).params.at(-1), expectedLimit);
			}).pipe(Effect.provide(sozlukLayer(access)));
		});

	clampCase(0, 2); // below min → 1, +1 probe
	clampCase(-3, 2);
	clampCase(1000, 201); // above max → 200, +1 probe
	clampCase(undefined, 51); // default 50, +1 probe
	clampCase(75, 76); // in-range
});

describe("Sozluk.listTermSummariesConnection — `first` clamp [1,100] (no SQL engine booted)", () => {
	const clampCase = (input: number | undefined, expectedLimit: number) =>
		it.effect(`first=${String(input)} → LIMIT ${expectedLimit}`, () => {
			const {access, queries} = scriptedAccess([0 /* count */, [] /* fetch */]);
			return Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				yield* sozluk.listTermSummariesConnection(input === undefined ? {} : {first: input});
				assert.strictEqual(fetchQuery(queries).params.at(-1), expectedLimit);
			}).pipe(Effect.provide(sozlukLayer(access)));
		});

	clampCase(0, 2); // below min → 1
	clampCase(-9, 2);
	clampCase(250, 101); // above max → 100
	clampCase(undefined, 21); // default 20
	clampCase(40, 41); // in-range
});

describe("Sozluk.listDefinitionsKeyset — MIXED-direction keyset (score desc, createdAt asc, id asc)", () => {
	const created = new Date("2026-01-01T00:00:00.000Z");

	it("a resolved cursor renders the full mixed-direction lexicographic tuple", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				// count, cursor-resolve (score/createdAt), fetch.
				const {access, queries} = scriptedAccess([1, {score: 5, createdAt: created}, []]);
				yield* Effect.gen(function* () {
					const sozluk = yield* Sozluk;
					yield* sozluk.listDefinitionsKeyset("a-term", {first: 10, after: "d7"});
				}).pipe(Effect.provide(sozlukLayer(access)));
				const {sql, params} = fetchQuery(queries);
				// desc lead → `<`, asc tiebreak → `>`. Per-arm equalities precede each strict cmp.
				assert.match(sql, /"definition_record"\."score" < \?/, "score desc → `<`");
				assert.match(sql, /"definition_record"\."created_at" > \?/, "createdAt asc → `>`");
				assert.match(sql, /"definition_record"\."id" > \?/, "id asc → `>`");
				assert.match(
					sql,
					/order by "definition_record"\."score" desc, "definition_record"\."created_at" asc, "definition_record"\."id" asc/,
					"orderBy mirrors the keyset tuple directions",
				);
				// Param order: the base `WHERE termSlug = ?` first, then the keyset arms,
				// then LIMIT. `createdAt` renders as epoch SECONDS (the column's timestamp
				// mode). The `id` cursor value is the opaque `after` ("d7"), NOT carried on
				// the resolved row (which holds only score/createdAt).
				const sec = Math.floor(created.getTime() / 1000);
				assert.deepStrictEqual(
					params,
					["a-term", 5, 5, sec, 5, sec, "d7", 11],
					"slug base-where, then score/createdAt from the resolved row, then `after` id, then LIMIT first+1",
				);
			}),
		));
});

describe("Sozluk.listDefinitionsKeyset — cursor-miss → empty page, NO further DB read", () => {
	it.effect("present `after` resolving to no row → empty page; fetch seam never dies", () => {
		let i = 0;
		const access: DrizzleAccess = {
			run: <A>(fn: (db: DrizzleDb) => Promise<A>) => {
				void fn;
				if (i === 0) {
					i++;
					return Effect.succeed(4 as A); // count
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
			const sozluk = yield* Sozluk;
			const page = yield* sozluk.listDefinitionsKeyset("a-term", {first: 10, after: "ghost"});
			assert.deepStrictEqual(page.rows, [], "miss → no rows");
			assert.strictEqual(page.hasNextPage, false);
			assert.strictEqual(page.endCursor, null);
			assert.strictEqual(page.totalCount, 4, "miss still reports the total it already read");
		}).pipe(Effect.provide(sozlukLayer(access)));
	});
});
