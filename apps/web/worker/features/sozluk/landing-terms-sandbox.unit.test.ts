/**
 * `Sozluk.getLandingTerms` sandbox-visibility wiring (#1424) — the security fix for
 * the public landing "sözlüğe son eklenenler" column. The read ranks terms by their
 * most recent LIVE definition, so the `definition_record` arm MUST carry the #1205
 * mask (`removed_at IS NULL AND sandboxed_at IS NULL`) beside the public `landingStats`
 * counts (#1391): a çaylak's sandbox-only term — whose `term_record` summary row can
 * persist with a zero live count — must never surface on the anonymous front door.
 *
 * Unit-tier per ADR 0082: row-level filtering is integration's job; what THIS proves is
 * that the read WIRES the sandbox clause into the recency query. The compiled SQL is
 * captured off a substituted `Drizzle` seam that renders each builder's `.toSQL()`
 * (the `Sozluk.connection.unit.test.ts` scripted-access idiom).
 */
import {assert, describe, it} from "@effect/vitest";
import {drizzle} from "drizzle-orm/d1";
import {Effect, Layer} from "effect";
import {Drizzle, type DrizzleAccess, type DrizzleDb, relations} from "../../db/Drizzle.ts";
import {Vote} from "../vote/Vote.ts";
import {Sozluk, SozlukLive} from "./Sozluk.ts";

// biome-ignore lint/plugin: `D1Database` is a host binding that can't be structurally constructed; only `prepare`/`batch` are exercised and the scripted `run` never lets the no-op queries execute.
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
		batch: () => Effect.die(new Error("getLandingTerms must not batch")),
	};
	return {access, queries};
}

// biome-ignore lint/plugin: a service double — `getLandingTerms` never reaches the Vote service.
const VoteStub = Layer.succeed(Vote, {
	cast: () => Effect.die(new Error("getLandingTerms must not cast a vote")),
	readMine: () => Effect.succeed(new Set<string>()),
	clearTarget: () => Effect.void,
} as unknown as typeof Vote.Service);

const sozlukLayer = (access: DrizzleAccess) =>
	SozlukLive.pipe(Layer.provide(VoteStub), Layer.provide(Layer.succeed(Drizzle, access)));

describe("Sozluk.getLandingTerms — public landing terms exclude sandbox-only terms (#1424)", () => {
	it.effect("the recency query masks removed_at AND sandboxed_at on the definition arm", () =>
		Effect.gen(function* () {
			// run #1: the grouped recency scan over definition_record; run #2: the summary fetch.
			const {access, queries} = scriptedAccess([[{termSlug: "race-condition"}], []]);
			yield* Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				yield* sozluk.getLandingTerms(5);
			}).pipe(Effect.provide(sozlukLayer(access)));

			const recency = queries[0];
			assert.isDefined(recency, "the recency scan executed against the seam");
			const sql = (recency as {sql: string}).sql.toLowerCase();
			assert.match(sql, /"definition_record"\."removed_at" is null/, "removed_at guard present");
			assert.match(sql, /"definition_record"\."sandboxed_at" is null/, "sandboxed_at mask present");
			// Never the inverted mask — that would drop the live terms the column is meant to show.
			assert.notMatch(sql, /sandboxed_at" is not null/, "mask is IS NULL, never IS NOT NULL");
			assert.match(sql, /group by "definition_record"\."term_slug"/, "grouped by term");
		}),
	);

	it.effect("a zero-row recency scan short-circuits the summary fetch", () =>
		Effect.gen(function* () {
			const {access, queries} = scriptedAccess([[] /* no live terms */]);
			const out = yield* Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.getLandingTerms(5);
			}).pipe(Effect.provide(sozlukLayer(access)));
			assert.deepStrictEqual(out, [], "no live terms → empty result");
			assert.strictEqual(queries.length, 1, "no second (summary) read when nothing matched");
		}),
	);

	it.effect("limit is clamped to [1,50]", () =>
		Effect.gen(function* () {
			const {access, queries} = scriptedAccess([[{termSlug: "x"}], []]);
			yield* Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				yield* sozluk.getLandingTerms(999);
			}).pipe(Effect.provide(sozlukLayer(access)));
			assert.strictEqual(queries[0]?.params.at(-1), 50, "above-max limit clamps to 50");
		}),
	);
});
