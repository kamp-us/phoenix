/**
 * `Funnel` — the çaylak→yazar conversion-funnel read model.
 *
 * Humans-only by construction: every query filters `user.type = 'human'`, so the
 * seeded `system` sentinel (ADR 0097) and any `bot` account never enter the funnel.
 * The gate + flag live at the fate resolver, not in these reads.
 */
import {and, count, eq, inArray, isNotNull, or} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import {Drizzle, type DrizzleDb, orDieAccess} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import {makeRollupWeeklyCohorts} from "./cohort-rollup.ts";

export interface TierPopulation {
	readonly caylakCount: number;
	readonly yazarCount: number;
}

export interface TierCountRow {
	readonly tier: string;
	readonly count: number;
}

export interface FirstContribution {
	readonly caylakCount: number;
	readonly contributingCount: number;
	readonly rate: number;
}

/**
 * A row's mere existence in `authorship_vouch` is enough for "received a vouch" —
 * this counts "was ever vouched for while çaylak", not an active/live-vouch
 * lifecycle concern (that is `VouchLedger`'s).
 */
export interface VouchRate {
	readonly caylakCount: number;
	readonly vouchedCount: number;
	readonly rate: number;
}

/**
 * Founding-cohort / pre-instrumentation yazars carry a null `promoted_at` (nothing
 * back-computes their promotion time — #1590 stamps forward only). They are excluded
 * from the median and surfaced as `notYetMeasurableCount`, never silently dropped.
 */
export interface TimeToPromotion {
	readonly medianMs: number | null;
	readonly measuredCount: number;
	readonly notYetMeasurableCount: number;
}

/**
 * The query builders below are extracted from the service, not inlined, so each
 * predicate is `.toSQL()`-inspectable in a unit test with no engine (ADR 0082 T1/T2).
 */
export const tierPopulationQuery = (db: DrizzleDb) =>
	db
		.select({tier: schema.user.tier, count: count()})
		.from(schema.user)
		.where(eq(schema.user.type, "human"))
		.groupBy(schema.user.tier);

export const foldTierPopulation = (rows: ReadonlyArray<TierCountRow>): TierPopulation => {
	const byTier = new Map(rows.map((r) => [r.tier, r.count]));
	return {
		caylakCount: byTier.get("çaylak") ?? 0,
		yazarCount: byTier.get("yazar") ?? 0,
	};
};

export const promotionRate = ({caylakCount, yazarCount}: TierPopulation): number => {
	const earned = caylakCount + yazarCount;
	return earned === 0 ? 0 : yazarCount / earned;
};

/**
 * The sandbox marker is the çaylak-sandbox seam of `kunye/sandbox.ts`
 * (`sandboxedAtForAuthor`); this reuses that column and adds no new write.
 */
export const contributingCaylaksQuery = (db: DrizzleDb) =>
	db
		.select({count: count()})
		.from(schema.user)
		.where(
			and(
				eq(schema.user.type, "human"),
				eq(schema.user.tier, "çaylak"),
				or(
					inArray(
						schema.user.id,
						db
							.select({id: schema.definitionRecord.authorId})
							.from(schema.definitionRecord)
							.where(isNotNull(schema.definitionRecord.sandboxedAt)),
					),
					inArray(
						schema.user.id,
						db
							.select({id: schema.postRecord.authorId})
							.from(schema.postRecord)
							.where(isNotNull(schema.postRecord.sandboxedAt)),
					),
					inArray(
						schema.user.id,
						db
							.select({id: schema.commentRecord.authorId})
							.from(schema.commentRecord)
							.where(isNotNull(schema.commentRecord.sandboxedAt)),
					),
				),
			),
		);

export const computeFirstContribution = (
	caylakCount: number,
	contributingCount: number,
): FirstContribution => ({
	caylakCount,
	contributingCount,
	rate: caylakCount === 0 ? 0 : contributingCount / caylakCount,
});

export const vouchedCaylaksQuery = (db: DrizzleDb) =>
	db
		.select({count: count()})
		.from(schema.user)
		.where(
			and(
				eq(schema.user.type, "human"),
				eq(schema.user.tier, "çaylak"),
				inArray(
					schema.user.id,
					db.select({id: schema.authorshipVouch.candidateId}).from(schema.authorshipVouch),
				),
			),
		);

export const computeVouchRate = (caylakCount: number, vouchedCount: number): VouchRate => ({
	caylakCount,
	vouchedCount,
	rate: caylakCount === 0 ? 0 : vouchedCount / caylakCount,
});

/**
 * The median lives in TS ({@link computeTimeToPromotion}), not SQLite — there is no
 * portable median aggregate, and the yazar population is small enough to pull whole.
 */
export const yazarPromotionTimesQuery = (db: DrizzleDb) =>
	db
		.select({promotedAt: schema.user.promotedAt, createdAt: schema.user.createdAt})
		.from(schema.user)
		.where(and(eq(schema.user.type, "human"), eq(schema.user.tier, "yazar")));

export interface YazarPromotionTimeRow {
	readonly promotedAt: Date | null;
	readonly createdAt: Date | null;
}

const median = (values: ReadonlyArray<number>): number | null => {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	// `sorted` is non-empty and `mid < length`, so both indexes are in-bounds — the
	// `?? 0` only satisfies `noUncheckedIndexedAccess`, it can never be reached.
	return sorted.length % 2 === 1
		? (sorted[mid] ?? 0)
		: ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

/**
 * A yazar with a non-null `promoted_at` but a null `created_at` is a data anomaly
 * (the registration stamp is always set) — it yields no measurable duration, so it
 * is skipped from the median without counting as pre-instrumentation.
 */
export const computeTimeToPromotion = (
	rows: ReadonlyArray<YazarPromotionTimeRow>,
): TimeToPromotion => {
	const durations: number[] = [];
	let notYetMeasurableCount = 0;
	for (const row of rows) {
		if (row.promotedAt === null) {
			notYetMeasurableCount++;
			continue;
		}
		if (row.createdAt === null) continue;
		durations.push(row.promotedAt.getTime() - row.createdAt.getTime());
	}
	return {
		medianMs: median(durations),
		measuredCount: durations.length,
		notYetMeasurableCount,
	};
};

export class Funnel extends Context.Service<
	Funnel,
	{
		readonly tierPopulation: () => Effect.Effect<TierPopulation>;
		readonly firstContribution: () => Effect.Effect<FirstContribution>;
		readonly vouchRate: () => Effect.Effect<VouchRate>;
		readonly timeToPromotion: () => Effect.Effect<TimeToPromotion>;
		/** The weekly cohort rollup pass (#7030) — the cron's entry point. */
		readonly rollupWeeklyCohorts: (now: Date) => Effect.Effect<{readonly cohorts: number}>;
	}
>()("@kampus/funnel/Funnel") {}

export const FunnelLive = Layer.effect(Funnel)(
	Effect.gen(function* () {
		const {run, batch} = orDieAccess(yield* Drizzle);
		const rollupWeeklyCohorts = makeRollupWeeklyCohorts(run, batch);

		return {
			tierPopulation: Effect.fn("Funnel.tierPopulation")(function* () {
				const rows = yield* run((db) => tierPopulationQuery(db));
				return foldTierPopulation(rows);
			}),
			firstContribution: Effect.fn("Funnel.firstContribution")(function* () {
				const tierRows = yield* run((db) => tierPopulationQuery(db));
				const {caylakCount} = foldTierPopulation(tierRows);
				const rows = yield* run((db) => contributingCaylaksQuery(db));
				return computeFirstContribution(caylakCount, rows[0]?.count ?? 0);
			}),
			vouchRate: Effect.fn("Funnel.vouchRate")(function* () {
				const tierRows = yield* run((db) => tierPopulationQuery(db));
				const {caylakCount} = foldTierPopulation(tierRows);
				const rows = yield* run((db) => vouchedCaylaksQuery(db));
				return computeVouchRate(caylakCount, rows[0]?.count ?? 0);
			}),
			timeToPromotion: Effect.fn("Funnel.timeToPromotion")(function* () {
				const rows = yield* run((db) => yazarPromotionTimesQuery(db));
				return computeTimeToPromotion(rows);
			}),
			rollupWeeklyCohorts,
		};
	}),
);
