/**
 * `Funnel` read-model coverage (#1589, #1593, #1591, #1592) — the tier-population
 * counts, the headline promotion rate, the first-contribution rate, the vouch rate,
 * and the humans-only filter, the decisions that are wrong-or-right with no engine
 * (ADR 0082 T1/T2). The
 * `Drizzle` seam is substituted directly (the `Report` / `promotion-sweep` idiom):
 *
 *   - **counts** — a scripted `run` feeds grouped rows to `foldTierPopulation`
 *     THROUGH the real `FunnelLive` service, proving çaylak/yazar map to the right
 *     fields and an absent tier reads `0`.
 *   - **promotion rate** — `promotionRate` derives yazar / (çaylak + yazar) from the
 *     population, both directly and end-to-end over the seam, covering the
 *     zero-population edge (`0`, never a `NaN`).
 *   - **first-contribution rate** — `computeFirstContribution` folds the çaylak count
 *     and contributing-çaylak count into the rate (zero-population edge → `0`), read
 *     end-to-end through the two-call seam; `contributingCaylaksQuery`'s rendered SQL
 *     is asserted to gate on human çaylaks with a `sandboxed_at IS NOT NULL` row.
 *   - **humans-only** — the query's rendered SQL (`.toSQL()` over a no-op D1) is
 *     asserted to filter `type = 'human'` and group by `tier`, so bot/system rows
 *     are excluded by construction. No engine executes.
 */
import {assert, describe, it} from "@effect/vitest";
import {drizzle} from "drizzle-orm/d1";
import {Effect, Layer} from "effect";
import {Drizzle, type DrizzleAccess, relations} from "../../db/Drizzle.ts";
import {
	computeFirstContribution,
	computeVouchRate,
	contributingCaylaksQuery,
	Funnel,
	FunnelLive,
	foldTierPopulation,
	promotionRate,
	type TierCountRow,
	tierPopulationQuery,
	vouchedCaylaksQuery,
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

// A `Drizzle` seam that dispenses queued responses in order — `firstContribution`
// issues two reads (the tier population, then the contributing-çaylak count), so it
// needs a distinct payload per call, not the single-shape `scriptedRows` above.
const scriptedSequence = (responses: ReadonlyArray<ReadonlyArray<unknown>>): DrizzleAccess => {
	let call = 0;
	return {
		run: <A>(_fn: (db: never) => Promise<A>) => Effect.succeed((responses[call++] ?? []) as A),
		batch: () => Effect.die(new Error("Funnel issues no batch")),
	};
};

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

describe("promotionRate — the headline share promoted çaylak→yazar (#1593)", () => {
	it("is yazar / (çaylak + yazar)", () => {
		assert.strictEqual(promotionRate({caylakCount: 3, yazarCount: 1}), 0.25);
		assert.strictEqual(promotionRate({caylakCount: 0, yazarCount: 4}), 1);
		assert.strictEqual(promotionRate({caylakCount: 4, yazarCount: 0}), 0);
	});

	it("an empty population reads 0, not NaN (fresh DB / zero-population edge)", () => {
		const rate = promotionRate({caylakCount: 0, yazarCount: 0});
		assert.strictEqual(rate, 0);
		assert.isFalse(Number.isNaN(rate));
	});
});

describe("Funnel.tierPopulation → promotionRate — end to end over the Drizzle seam", () => {
	it.effect("derives the headline rate from the counts the seam returns", () =>
		Effect.gen(function* () {
			const funnel = yield* Funnel;
			const population = yield* funnel.tierPopulation();
			assert.strictEqual(promotionRate(population), 0.2);
		}).pipe(
			Effect.provide(
				funnelLayer(
					scriptedRows([
						{tier: "çaylak", count: 8},
						{tier: "yazar", count: 2},
					]),
				),
			),
		),
	);

	it.effect("an empty seam yields the zero-population rate (0, not NaN)", () =>
		Effect.gen(function* () {
			const funnel = yield* Funnel;
			const population = yield* funnel.tierPopulation();
			assert.strictEqual(promotionRate(population), 0);
		}).pipe(Effect.provide(funnelLayer(scriptedRows([])))),
	);
});

describe("computeFirstContribution — rate over the çaylak population (#1591)", () => {
	it("rate = contributing / çaylak", () => {
		assert.deepStrictEqual(computeFirstContribution(8, 2), {
			caylakCount: 8,
			contributingCount: 2,
			rate: 0.25,
		});
	});

	it("zero çaylaks ⇒ rate 0, never a divide-by-zero (empty-population edge)", () => {
		assert.deepStrictEqual(computeFirstContribution(0, 0), {
			caylakCount: 0,
			contributingCount: 0,
			rate: 0,
		});
	});

	it("all çaylaks contributing ⇒ rate 1", () => {
		assert.deepStrictEqual(computeFirstContribution(5, 5), {
			caylakCount: 5,
			contributingCount: 5,
			rate: 1,
		});
	});
});

describe("Funnel.firstContribution — the read through the Drizzle seam", () => {
	it.effect("folds the tier + contributing counts into the rate", () =>
		Effect.gen(function* () {
			const funnel = yield* Funnel;
			const contribution = yield* funnel.firstContribution();
			assert.deepStrictEqual(contribution, {caylakCount: 10, contributingCount: 3, rate: 0.3});
		}).pipe(
			Effect.provide(
				funnelLayer(
					// call 1: tier population → 10 çaylaks; call 2: contributing count → 3
					scriptedSequence([
						[
							{tier: "çaylak", count: 10},
							{tier: "yazar", count: 6},
						],
						[{count: 3}],
					]),
				),
			),
		),
	);

	it.effect("no çaylaks ⇒ 0 rate (zero-population edge, no divide-by-zero)", () =>
		Effect.gen(function* () {
			const funnel = yield* Funnel;
			const contribution = yield* funnel.firstContribution();
			assert.deepStrictEqual(contribution, {caylakCount: 0, contributingCount: 0, rate: 0});
		}).pipe(Effect.provide(funnelLayer(scriptedSequence([[], [{count: 0}]])))),
	);
});

describe("computeVouchRate — rate over the çaylak population (#1592)", () => {
	it("rate = vouched / çaylak", () => {
		assert.deepStrictEqual(computeVouchRate(8, 2), {
			caylakCount: 8,
			vouchedCount: 2,
			rate: 0.25,
		});
	});

	it("zero çaylaks ⇒ rate 0, never a divide-by-zero (empty-population edge)", () => {
		assert.deepStrictEqual(computeVouchRate(0, 0), {
			caylakCount: 0,
			vouchedCount: 0,
			rate: 0,
		});
	});

	it("all çaylaks vouched ⇒ rate 1", () => {
		assert.deepStrictEqual(computeVouchRate(5, 5), {
			caylakCount: 5,
			vouchedCount: 5,
			rate: 1,
		});
	});
});

describe("Funnel.vouchRate — the read through the Drizzle seam", () => {
	it.effect("folds the tier + vouched counts into the rate", () =>
		Effect.gen(function* () {
			const funnel = yield* Funnel;
			const vouch = yield* funnel.vouchRate();
			assert.deepStrictEqual(vouch, {caylakCount: 10, vouchedCount: 4, rate: 0.4});
		}).pipe(
			Effect.provide(
				funnelLayer(
					// call 1: tier population → 10 çaylaks; call 2: vouched count → 4
					scriptedSequence([
						[
							{tier: "çaylak", count: 10},
							{tier: "yazar", count: 6},
						],
						[{count: 4}],
					]),
				),
			),
		),
	);

	it.effect("no çaylaks ⇒ 0 rate (zero-population edge, no divide-by-zero)", () =>
		Effect.gen(function* () {
			const funnel = yield* Funnel;
			const vouch = yield* funnel.vouchRate();
			assert.deepStrictEqual(vouch, {caylakCount: 0, vouchedCount: 0, rate: 0});
		}).pipe(Effect.provide(funnelLayer(scriptedSequence([[], [{count: 0}]])))),
	);
});

describe("vouchedCaylaksQuery — human çaylaks with an authorship_vouch candidate row (rendered SQL)", () => {
	const {sql, params} = vouchedCaylaksQuery(renderDb).toSQL();

	it("counts over the user table, filtered to human çaylaks", () => {
		assert.match(sql, /from\s+"user"/i);
		assert.match(sql, /count\(\*\)/i);
		assert.match(sql, /"user"\."type"\s*=\s*\?/i);
		assert.match(sql, /"user"\."tier"\s*=\s*\?/i);
		assert.include(params, "human");
		assert.include(params, "çaylak");
	});

	it("gates on membership in the authorship_vouch candidate set", () => {
		assert.match(sql, /"authorship_vouch"/i);
		assert.match(sql, /"candidate_id"/i);
		assert.match(sql, /"user"\."id"\s+in/i);
	});
});

describe("contributingCaylaksQuery — human çaylaks with a sandboxed contribution (rendered SQL)", () => {
	const {sql, params} = contributingCaylaksQuery(renderDb).toSQL();

	it("counts over the user table, filtered to human çaylaks", () => {
		assert.match(sql, /from\s+"user"/i);
		assert.match(sql, /count\(\*\)/i);
		assert.match(sql, /"user"\."type"\s*=\s*\?/i);
		assert.match(sql, /"user"\."tier"\s*=\s*\?/i);
		assert.include(params, "human");
		assert.include(params, "çaylak");
	});

	it("gates on a sandboxed contribution across the three content tables", () => {
		assert.match(sql, /"definition_record"/i);
		assert.match(sql, /"post_record"/i);
		assert.match(sql, /"comment_record"/i);
		assert.match(sql, /"sandboxed_at"\s+is\s+not\s+null/i);
	});
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
