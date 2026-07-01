/**
 * `Funnel` — the conversion-funnel read model (#1589, the çaylak→yazar readout's
 * tracer bullet). Its one read, {@link Funnel.tierPopulation}, is the current tier
 * population — how many accounts sit at each rung of the authorship ladder
 * (`çaylak`, `yazar`) — the simplest funnel number the Phase-2 rate/time metrics
 * extend off this same service. {@link promotionRate} (#1593) derives the loop's
 * headline number from that population — the share of the human earned-authorship
 * population that has crossed to `yazar`; {@link Funnel.firstContribution} (#1591)
 * adds the first-contribution rate — the share of human çaylaks with ≥ 1 sandboxed
 * contribution, the newcomer-engagement signal. {@link Funnel.vouchRate} (#1592)
 * adds the vouch rate — the share of human çaylaks who received ≥ 1 vouch (kefil),
 * the signal of whether the established community sponsors newcomers.
 *
 * Humans-only by construction: the count filters `user.type = 'human'`, so the
 * seeded `system` sentinel (ADR 0097) and any `bot` account (agents, v1.1) never
 * enter the funnel — a conversion metric measures the human çaylak→yazar journey,
 * not machine rows. The filter is single-sourced in {@link tierPopulationQuery} so
 * the humans-only predicate can't drift from what the service reads.
 *
 * Reads go through `run`/`orDieAccess`, so infra failures die here (the
 * domain-boundary rule, `.patterns/effect-errors.md`) and the public signature
 * carries no error — the gate + flag live at the fate resolver, not in the read.
 */
import {and, count, eq, inArray, isNotNull, or} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import {Drizzle, type DrizzleDb, orDieAccess} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";

/** The two counted rungs of the stored authorship ladder (`STORED_TIERS`). */
export interface TierPopulation {
	/** Human accounts still at the `çaylak` floor. */
	readonly caylakCount: number;
	/** Human accounts promoted to `yazar`. */
	readonly yazarCount: number;
}

/** One grouped row of the tier-population read: a stored tier and its human count. */
export interface TierCountRow {
	readonly tier: string;
	readonly count: number;
}

/**
 * The first-contribution metric (#1591): among human çaylaks, how many have made
 * ≥ 1 sandboxed contribution — the engagement signal answering "do newcomers
 * contribute at all, or lurk?" (the epic's named risk).
 */
export interface FirstContribution {
	/** The denominator: human accounts at the `çaylak` floor. */
	readonly caylakCount: number;
	/** The numerator: human çaylaks with ≥ 1 sandboxed contribution. */
	readonly contributingCount: number;
	/**
	 * `contributingCount / caylakCount`, in `[0, 1]`. `0` when there are no çaylaks
	 * (an empty population is a well-formed 0% rate, never a divide-by-zero).
	 */
	readonly rate: number;
}

/**
 * The vouch metric (#1592): among human çaylaks, how many have received ≥ 1 vouch
 * (kefil) — appearing as a `candidate_id` in the `authorship_vouch` ledger. Reads
 * whether the established community is sponsoring newcomers. A row's mere existence
 * is enough for "received a vouch" — this counts "was ever vouched for while çaylak",
 * not an active/live-vouch lifecycle concern (that is `VouchLedger`'s).
 */
export interface VouchRate {
	/** The denominator: human accounts at the `çaylak` floor. */
	readonly caylakCount: number;
	/** The numerator: human çaylaks with ≥ 1 `authorship_vouch` candidate row. */
	readonly vouchedCount: number;
	/**
	 * `vouchedCount / caylakCount`, in `[0, 1]`. `0` when there are no çaylaks
	 * (an empty population is a well-formed 0% rate, never a divide-by-zero).
	 */
	readonly rate: number;
}

/**
 * The time-to-promotion metric (#1594): how long the loop takes from registration
 * to yazar, measured `promoted_at − created_at` over human yazars that carry a
 * non-null `promoted_at` (i.e. promoted since instrumentation landed, #1590). A
 * single legible product number — the **median** — not a histogram engine.
 *
 * Founding-cohort / pre-instrumentation yazars carry a null `promoted_at` (no
 * source of truth back-computes their promotion time — that is why #1590 stamps
 * forward only) and are **excluded from the median** and surfaced as an explicit
 * {@link notYetMeasurableCount}, never silently dropped.
 */
export interface TimeToPromotion {
	/**
	 * The median of `promoted_at − created_at` in milliseconds over measurable
	 * yazars, or `null` when none are measurable yet (empty measured population —
	 * a well-formed "no number yet", never a `NaN`).
	 */
	readonly medianMs: number | null;
	/** The measured population: human yazars with a non-null `promoted_at`. */
	readonly measuredCount: number;
	/**
	 * Human yazars excluded for a null `promoted_at` (founding-cohort /
	 * pre-instrumentation) — the "not yet measurable" count, surfaced not dropped.
	 */
	readonly notYetMeasurableCount: number;
}

/**
 * The humans-only tier-population query — a `GROUP BY tier` count over the `user`
 * table filtered to `type = 'human'`. Extracted as a pure builder (not inlined in
 * the service) so the humans-only filter is unit-inspectable via `.toSQL()` with no
 * engine, exactly the `promotion-sweep` render idiom (ADR 0082 T1/T2).
 */
export const tierPopulationQuery = (db: DrizzleDb) =>
	db
		.select({tier: schema.user.tier, count: count()})
		.from(schema.user)
		.where(eq(schema.user.type, "human"))
		.groupBy(schema.user.tier);

/**
 * Fold the grouped rows onto the {@link TierPopulation} shape. A tier absent from
 * the rows (no human at that rung yet) reads as `0`, so a fresh DB or an all-çaylak
 * population is a well-formed answer, never a missing field.
 */
export const foldTierPopulation = (rows: ReadonlyArray<TierCountRow>): TierPopulation => {
	const byTier = new Map(rows.map((r) => [r.tier, r.count]));
	return {
		caylakCount: byTier.get("çaylak") ?? 0,
		yazarCount: byTier.get("yazar") ?? 0,
	};
};

/**
 * The loop's headline number (#1593): the share of the earned-authorship human
 * population that crossed to `yazar` — `yazar / (çaylak + yazar)`, a fraction in
 * `[0, 1]`. An empty population (`çaylak + yazar === 0`) reads as `0` rather than a
 * `NaN` division-by-zero, so a fresh DB is a well-formed `0%`, not a broken number.
 */
export const promotionRate = ({caylakCount, yazarCount}: TierPopulation): number => {
	const earned = caylakCount + yazarCount;
	return earned === 0 ? 0 : yazarCount / earned;
};

/**
 * Count the human çaylaks with ≥ 1 sandboxed contribution — a `çaylak`-tier human
 * whose id authors any `sandboxed_at IS NOT NULL` row across the three content
 * tables (definition / post / comment). The sandbox marker is the çaylak-sandbox
 * seam of `kunye/sandbox.ts` (`sandboxedAtForAuthor`); this reuses that existing
 * column and adds no new write. Extracted as a pure builder (the `tierPopulationQuery`
 * idiom) so the humans-only + çaylak-only + sandboxed-authorship predicate is
 * `.toSQL()`-inspectable with no engine (ADR 0082 T1/T2).
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

/**
 * Fold the two counts onto {@link FirstContribution}, guarding the zero-population
 * edge: with no çaylaks the rate is `0`, never a divide-by-zero (ADR 0040 seam).
 */
export const computeFirstContribution = (
	caylakCount: number,
	contributingCount: number,
): FirstContribution => ({
	caylakCount,
	contributingCount,
	rate: caylakCount === 0 ? 0 : contributingCount / caylakCount,
});

/**
 * Count the human çaylaks with ≥ 1 vouch — a `çaylak`-tier human whose id appears
 * as a `candidate_id` in the `authorship_vouch` ledger (mere row existence, per
 * #1592). Extracted as a pure builder (the `tierPopulationQuery` idiom) so the
 * humans-only + çaylak-only + vouched predicate is `.toSQL()`-inspectable with no
 * engine (ADR 0082 T1/T2). No new write: it reads the existing ledger table.
 */
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

/**
 * Fold the two counts onto {@link VouchRate}, guarding the zero-population edge:
 * with no çaylaks the rate is `0`, never a divide-by-zero (ADR 0040 seam).
 */
export const computeVouchRate = (caylakCount: number, vouchedCount: number): VouchRate => ({
	caylakCount,
	vouchedCount,
	rate: caylakCount === 0 ? 0 : vouchedCount / caylakCount,
});

/**
 * Select the promotion/registration timestamps of every human yazar — the raw input
 * to the median fold. Extracted as a pure builder (the `tierPopulationQuery` idiom)
 * so the humans-only + yazar-only predicate is `.toSQL()`-inspectable with no engine
 * (ADR 0082 T1/T2). The median itself lives in TS ({@link computeTimeToPromotion}),
 * not SQLite — there is no portable median aggregate, and the population is small
 * (yazars, not all users), so pulling the timestamps and folding is the simpler seam.
 */
export const yazarPromotionTimesQuery = (db: DrizzleDb) =>
	db
		.select({promotedAt: schema.user.promotedAt, createdAt: schema.user.createdAt})
		.from(schema.user)
		.where(and(eq(schema.user.type, "human"), eq(schema.user.tier, "yazar")));

/** One human-yazar row for the time-to-promotion fold: its two nullable stamps. */
export interface YazarPromotionTimeRow {
	readonly promotedAt: Date | null;
	readonly createdAt: Date | null;
}

/** The median of a numeric list, or `null` when empty. Even population ⇒ the mean of
 * the two central values (the input need not be pre-sorted). */
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
 * Fold the human-yazar timestamp rows onto {@link TimeToPromotion}: measure
 * `promoted_at − created_at` (ms) for yazars with a non-null `promoted_at`, take
 * the median, and count the null-`promoted_at` yazars as `notYetMeasurableCount`.
 * A yazar with a non-null `promoted_at` but a null `created_at` is a data anomaly
 * (registration stamp is always set) — it yields no measurable duration, so it is
 * defensively skipped from the median without being counted as pre-instrumentation.
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
		/** The current human tier population (çaylak + yazar counts). */
		readonly tierPopulation: () => Effect.Effect<TierPopulation>;
		/** The first-contribution rate over the human-çaylak population (#1591). */
		readonly firstContribution: () => Effect.Effect<FirstContribution>;
		/** The vouch rate over the human-çaylak population (#1592). */
		readonly vouchRate: () => Effect.Effect<VouchRate>;
		/** The median registration→yazar time over measurable yazars (#1594). */
		readonly timeToPromotion: () => Effect.Effect<TimeToPromotion>;
	}
>()("@kampus/funnel/Funnel") {}

export const FunnelLive = Layer.effect(Funnel)(
	Effect.gen(function* () {
		const {run} = orDieAccess(yield* Drizzle);

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
		};
	}),
);
