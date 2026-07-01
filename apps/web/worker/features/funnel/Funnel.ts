/**
 * `Funnel` — the conversion-funnel read model (#1589, the çaylak→yazar readout's
 * tracer bullet). Its one read, {@link Funnel.tierPopulation}, is the current tier
 * population — how many accounts sit at each rung of the authorship ladder
 * (`çaylak`, `yazar`) — the simplest funnel number the Phase-2 rate/time metrics
 * extend off this same service. The first such extension, {@link promotionRate}
 * (#1593), derives the loop's headline number from that population: the share of the
 * human earned-authorship population that has crossed to `yazar`.
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
import {count, eq} from "drizzle-orm";
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

export class Funnel extends Context.Service<
	Funnel,
	{
		/** The current human tier population (çaylak + yazar counts). */
		readonly tierPopulation: () => Effect.Effect<TierPopulation>;
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
		};
	}),
);
