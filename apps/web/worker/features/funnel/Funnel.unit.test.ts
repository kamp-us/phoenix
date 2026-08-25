/**
 * `Funnel` read-model coverage — the counts, rates, and humans-only filter, all decided
 * with no engine (ADR 0082). The `Drizzle` seam is substituted directly and the SQL
 * assertions render `.toSQL()` over a no-op D1.
 */
import {assert, describe, it} from "@effect/vitest";
import {drizzle} from "drizzle-orm/d1";
import {Effect, Layer} from "effect";
import {Drizzle, type DrizzleAccess, relations} from "../../db/Drizzle.ts";
import {
	cohortRollupRowsQuery,
	computeFirstContribution,
	computeTimeToPromotion,
	computeVouchRate,
	contributingCaylaksQuery,
	Funnel,
	FunnelLive,
	foldTierPopulation,
	foundingPromotionsQuery,
	promotionRate,
	type TierCountRow,
	tierPopulationQuery,
	vouchEvidenceMissingQuery,
	vouchedCaylaksQuery,
	yazarPromotionTimesQuery,
} from "./Funnel.ts";

const DAY = 1000 * 60 * 60 * 24;
/** A yazar row `d` days after `base` (default: registered at epoch, promoted `d` days later). */
const yazarAfterDays = (d: number, base = 0) => ({
	createdAt: new Date(base),
	promotedAt: new Date(base + d * DAY),
});

// A real drizzle client over a no-op D1, used ONLY to render `.toSQL()`; nothing executes.
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

// `run` ignores its builder and returns queued rows; `batch` dies, as the read issues none.
const scriptedRows = (rows: ReadonlyArray<TierCountRow>): DrizzleAccess => ({
	run: <A>(_fn: (db: never) => Promise<A>) => Effect.succeed(rows as A),
	batch: () => Effect.die(new Error("Funnel.tierPopulation issues no batch")),
});

const funnelLayer = (access: DrizzleAccess) =>
	FunnelLive.pipe(Layer.provide(Layer.succeed(Drizzle, access)));

// Dispenses queued responses in order, for the reads that issue two queries and so need a
// distinct payload per call rather than the single-shape `scriptedRows` above.
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

describe("computeTimeToPromotion — median registration→yazar over measurable yazars (#1594)", () => {
	it("odd population ⇒ the middle duration (in ms)", () => {
		const result = computeTimeToPromotion([
			yazarAfterDays(2),
			yazarAfterDays(10),
			yazarAfterDays(4),
		]);
		assert.deepStrictEqual(result, {
			medianMs: 4 * DAY,
			measuredCount: 3,
			notYetMeasurableCount: 0,
		});
	});

	it("even population ⇒ the mean of the two central durations", () => {
		const result = computeTimeToPromotion([
			yazarAfterDays(2),
			yazarAfterDays(4),
			yazarAfterDays(6),
			yazarAfterDays(12),
		]);
		// sorted: 2, 4, 6, 12 days → median = (4 + 6) / 2 = 5 days
		assert.strictEqual(result.medianMs, 5 * DAY);
		assert.strictEqual(result.measuredCount, 4);
	});

	it("null promoted_at yazars are excluded from the median and counted as not-yet-measurable", () => {
		const result = computeTimeToPromotion([
			yazarAfterDays(3),
			{createdAt: new Date(0), promotedAt: null},
			yazarAfterDays(9),
			{createdAt: new Date(0), promotedAt: null},
		]);
		assert.strictEqual(result.medianMs, 6 * DAY); // (3 + 9) / 2
		assert.strictEqual(result.measuredCount, 2);
		assert.strictEqual(result.notYetMeasurableCount, 2);
	});

	it("empty population ⇒ null median (never NaN), zero counts", () => {
		const result = computeTimeToPromotion([]);
		assert.deepStrictEqual(result, {
			medianMs: null,
			measuredCount: 0,
			notYetMeasurableCount: 0,
		});
	});

	it("all yazars pre-instrumentation (null promoted_at) ⇒ null median, all not-yet-measurable", () => {
		const result = computeTimeToPromotion([
			{createdAt: new Date(0), promotedAt: null},
			{createdAt: new Date(0), promotedAt: null},
		]);
		assert.strictEqual(result.medianMs, null);
		assert.strictEqual(result.measuredCount, 0);
		assert.strictEqual(result.notYetMeasurableCount, 2);
	});

	it("a null created_at with a set promoted_at is a defensive skip (not measured, not counted)", () => {
		const result = computeTimeToPromotion([
			yazarAfterDays(5),
			{createdAt: null, promotedAt: new Date(DAY)},
		]);
		assert.strictEqual(result.medianMs, 5 * DAY);
		assert.strictEqual(result.measuredCount, 1);
		assert.strictEqual(result.notYetMeasurableCount, 0);
	});
});

describe("Funnel.timeToPromotion — the read through the Drizzle seam", () => {
	it.effect("folds the yazar timestamp rows the seam returns into the median", () =>
		Effect.gen(function* () {
			const funnel = yield* Funnel;
			const result = yield* funnel.timeToPromotion();
			assert.deepStrictEqual(result, {
				medianMs: 4 * DAY,
				measuredCount: 3,
				notYetMeasurableCount: 1,
			});
		}).pipe(
			Effect.provide(
				funnelLayer(
					scriptedSequence([
						[
							yazarAfterDays(2),
							yazarAfterDays(4),
							yazarAfterDays(10),
							{createdAt: new Date(0), promotedAt: null},
						],
					]),
				),
			),
		),
	);

	it.effect("an empty seam yields a null median (no measurable yazar yet)", () =>
		Effect.gen(function* () {
			const funnel = yield* Funnel;
			const result = yield* funnel.timeToPromotion();
			assert.strictEqual(result.medianMs, null);
			assert.isFalse(Number.isNaN(result.medianMs));
		}).pipe(Effect.provide(funnelLayer(scriptedSequence([[]])))),
	);
});

describe("yazarPromotionTimesQuery — human yazars' promotion/registration stamps (rendered SQL)", () => {
	const {sql, params} = yazarPromotionTimesQuery(renderDb).toSQL();

	it("selects promoted_at and created_at over the user table", () => {
		assert.match(sql, /from\s+"user"/i);
		assert.match(sql, /"promoted_at"/i);
		assert.match(sql, /"created_at"/i);
	});

	it("filters to human yazars", () => {
		assert.match(sql, /"user"\."type"\s*=\s*\?/i);
		assert.match(sql, /"user"\."tier"\s*=\s*\?/i);
		assert.include(params, "human");
		assert.include(params, "yazar");
	});
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

// ---------------------------------------------------------------------------
// The cohort read model (#7031) — the live five-stage funnel over existing rows,
// the rollup-table read, and the two known data holes as explicit counts.
// ---------------------------------------------------------------------------

/** `2026-08-03` is a UTC Monday — every fixture cohort week buckets there. */
const at = (iso: string): Date => new Date(iso);

const cohortUserRow = (
	id: string,
	createdAt: Date,
	promotedAt: Date | null = null,
): {id: string; createdAt: Date; promotedAt: Date | null} => ({id, createdAt, promotedAt});

describe("foundingPromotionsQuery — the pre-#1590 founding cohort (rendered SQL)", () => {
	const {sql, params} = foundingPromotionsQuery(renderDb).toSQL();

	it("counts human yazars with no promoted_at stamp", () => {
		assert.match(sql, /from\s+"user"/i);
		assert.match(sql, /count\(\*\)/i);
		assert.match(sql, /"user"\."type"\s*=\s*\?/i);
		assert.match(sql, /"user"\."tier"\s*=\s*\?/i);
		assert.match(sql, /"promoted_at"\s+is\s+null/i);
		assert.include(params, "human");
		assert.include(params, "yazar");
	});
});

describe("vouchEvidenceMissingQuery — yazars with no surviving vouch row (rendered SQL)", () => {
	const {sql, params} = vouchEvidenceMissingQuery(renderDb).toSQL();

	it("counts human yazars outside the authorship_vouch candidate set", () => {
		assert.match(sql, /from\s+"user"/i);
		assert.match(sql, /count\(\*\)/i);
		assert.match(sql, /"user"\."type"\s*=\s*\?/i);
		assert.match(sql, /"user"\."tier"\s*=\s*\?/i);
		assert.include(params, "human");
		assert.include(params, "yazar");
	});

	it("excludes via NOT IN over the ledger's candidate set — withdrawn rows leave no trace", () => {
		assert.match(sql, /"authorship_vouch"/i);
		assert.match(sql, /"candidate_id"/i);
		assert.match(sql, /"user"\."id"\s+not\s+in/i);
	});
});

describe("cohortRollupRowsQuery — tracer B's durable weekly record (rendered SQL)", () => {
	const {sql} = cohortRollupRowsQuery(renderDb).toSQL();

	it("reads the whole rollup table, oldest week first", () => {
		assert.match(sql, /from\s+"cohort_week_rollup"/i);
		assert.match(sql, /order by\s+"cohort_week_rollup"\."cohort_week"\s+asc/i);
	});
});

describe("Funnel.cohorts — the live fold + holes through the Drizzle seam", () => {
	// The fold's input order: users, activity days, definitions, posts, comments, vouches.
	// Funnel.cohorts then adds the two hole counts.
	const scriptedCohortInputs = (
		overrides: Partial<Record<number, ReadonlyArray<unknown>>> = {},
	): DrizzleAccess => {
		const base: ReadonlyArray<ReadonlyArray<unknown>> = [
			[
				cohortUserRow("u1", at("2026-08-03T10:00:00Z")),
				cohortUserRow("u2", at("2026-08-05T10:00:00Z")),
			],
			[{userId: "u1", day: "2026-08-04"}],
			[{key: "u1", firstAt: at("2026-08-05T12:00:00Z")}],
			[],
			[],
			[{key: "u1", firstAt: at("2026-08-06T09:00:00Z")}],
		];
		const responses = base.map((rows, i) => overrides[i] ?? rows);
		return scriptedSequence([...responses, [{value: 2}], [{value: 1}]]);
	};

	it.effect("folds per-week stages plus D1/D7 returns and surfaces both holes", () =>
		Effect.gen(function* () {
			const funnel = yield* Funnel;
			const {weeks, unmeasurable} = yield* funnel.cohorts();
			assert.deepStrictEqual(weeks, [
				{
					cohortWeek: "2026-08-03",
					signedUp: 2,
					returnedDays2to7: 0,
					firstContributed7d: 1,
					vouched7d: 1,
					promoted7d: 0,
					d1Returned: 1,
					d7Returned: 1,
					d1ReturnRate: 0.5,
					d7ReturnRate: 0.5,
				},
			]);
			assert.deepStrictEqual(unmeasurable, {
				foundingPromotionsUnmeasurable: 2,
				vouchEvidenceUnmeasurable: 1,
			});
		}).pipe(Effect.provide(funnelLayer(scriptedCohortInputs()))),
	);

	it.effect("an untouched population reads all-zero weeks with empty holes", () =>
		Effect.gen(function* () {
			const funnel = yield* Funnel;
			const {weeks, unmeasurable} = yield* funnel.cohorts();
			assert.deepStrictEqual(weeks, []);
			assert.deepStrictEqual(unmeasurable, {
				foundingPromotionsUnmeasurable: 0,
				vouchEvidenceUnmeasurable: 0,
			});
		}).pipe(
			Effect.provide(
				funnelLayer(scriptedSequence([[], [], [], [], [], [], [{value: 0}], [{value: 0}]])),
			),
		),
	);
});

const rollupRow = {
	cohortWeek: "2026-07-27",
	signedUp: 4,
	returnedDays2to7: 2,
	firstContributed7d: 1,
	vouched7d: 1,
	promoted7d: 1,
	d1Returned: 2,
	d7Returned: 3,
	d1ReturnRate: 0.5,
	d7ReturnRate: 0.75,
};

describe("Funnel.cohortRollups — the durable weekly record through the Drizzle seam", () => {
	it.effect("reads the rollup table rows back unchanged, oldest first", () =>
		Effect.gen(function* () {
			const funnel = yield* Funnel;
			const rollups = yield* funnel.cohortRollups();
			assert.deepStrictEqual(rollups, [rollupRow]);
		}).pipe(Effect.provide(funnelLayer(scriptedSequence([[rollupRow]])))),
	);
});
