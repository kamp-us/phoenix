/**
 * `Funnel` read-model coverage (#1589) — the tier-population counts and the
 * humans-only filter, the two decisions that are wrong-or-right with no engine
 * (ADR 0082 T1/T2). The `Drizzle` seam is substituted directly (the `Report` /
 * `promotion-sweep` idiom):
 *
 *   - **counts** — a scripted `run` feeds grouped rows to `foldTierPopulation`
 *     THROUGH the real `FunnelLive` service, proving çaylak/yazar map to the right
 *     fields and an absent tier reads `0`.
 *   - **humans-only** — the query's rendered SQL (`.toSQL()` over a no-op D1) is
 *     asserted to filter `type = 'human'` and group by `tier`, so bot/system rows
 *     are excluded by construction. No engine executes.
 */
import {assert, describe, it} from "@effect/vitest";
import {drizzle} from "drizzle-orm/d1";
import {Effect, Layer} from "effect";
import {Drizzle, type DrizzleAccess, relations} from "../../db/Drizzle.ts";
import {
	Funnel,
	FunnelLive,
	foldTierPopulation,
	type TierCountRow,
	tierPopulationQuery,
} from "./Funnel.ts";

// A real drizzle client over a no-op D1 — used ONLY to render the query's `.toSQL()`;
// it never executes.
// biome-ignore lint/plugin: `D1Database` is a host binding that can't be structurally constructed in a fake; nothing here executes against it.
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

// A scripted `Drizzle` seam: `run` ignores its builder and returns the queued rows
// (no engine); `batch` dies — the read issues none.
const scriptedRows = (rows: ReadonlyArray<TierCountRow>): DrizzleAccess => ({
	run: <A>(_fn: (db: never) => Promise<A>) => Effect.succeed(rows as A),
	batch: () => Effect.die(new Error("Funnel.tierPopulation issues no batch")),
});

const funnelLayer = (access: DrizzleAccess) =>
	FunnelLive.pipe(Layer.provide(Layer.succeed(Drizzle, access)));

describe("foldTierPopulation — grouped rows → the two counts", () => {
	it("maps çaylak and yazar rows to their fields", () => {
		assert.deepStrictEqual(
			foldTierPopulation([
				{tier: "çaylak", count: 7},
				{tier: "yazar", count: 3},
			]),
			{caylakCount: 7, yazarCount: 3},
		);
	});

	it("an absent tier reads 0 (fresh DB / all-çaylak population)", () => {
		assert.deepStrictEqual(foldTierPopulation([{tier: "çaylak", count: 5}]), {
			caylakCount: 5,
			yazarCount: 0,
		});
		assert.deepStrictEqual(foldTierPopulation([]), {caylakCount: 0, yazarCount: 0});
	});
});

describe("Funnel.tierPopulation — the read through the Drizzle seam", () => {
	it.effect("folds the grouped rows the seam returns into the population", () =>
		Effect.gen(function* () {
			const funnel = yield* Funnel;
			const population = yield* funnel.tierPopulation();
			assert.deepStrictEqual(population, {caylakCount: 12, yazarCount: 4});
		}).pipe(
			Effect.provide(
				funnelLayer(
					scriptedRows([
						{tier: "çaylak", count: 12},
						{tier: "yazar", count: 4},
					]),
				),
			),
		),
	);
});

describe("tierPopulationQuery — humans-only, grouped by tier (rendered SQL)", () => {
	const {sql, params} = tierPopulationQuery(renderDb).toSQL();

	it("filters type = 'human' — bot/system rows are excluded", () => {
		assert.match(sql, /where\s+"user"\."type"\s*=\s*\?/i);
		assert.include(params, "human");
	});

	it("groups by tier so each rung is counted separately", () => {
		assert.match(sql, /group by\s+"user"\."tier"/i);
	});

	it("counts over the user table", () => {
		assert.match(sql, /from\s+"user"/i);
		assert.match(sql, /count\(\*\)/i);
	});
});
