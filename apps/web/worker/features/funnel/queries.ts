/**
 * `funnel.summary` — the founder/mod conversion readout's single gated read. The
 * {@link requireFunnelAccess} capability gate (platform-moderation only) guards it, so a
 * non-mod read fails the invisible {@link Denied}.
 *
 * A synthetic singleton like `stats.landingStats`: the wire type is the NAME string, not the
 * view class, so the entity stays off the source-completeness path.
 */
import {Fate} from "@kampus/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {Denied} from "../kunye/errors.ts";
import {Funnel, promotionRate} from "./Funnel.ts";
import {requireFunnelAccess, ViewFunnel} from "./gate.ts";

const FUNNEL_SUMMARY_ID = "summary";

// `yield* ViewFunnel` requires the proof, so the counts are unreachable without a discharged
// grant.
const summaryGated = Effect.fn("funnel.summaryGated")(function* () {
	yield* ViewFunnel;
	const funnel = yield* Funnel;
	const population = yield* funnel.tierPopulation();
	const {rate: firstContributionRate} = yield* funnel.firstContribution();
	const {rate: vouchRate} = yield* funnel.vouchRate();
	const {medianMs, notYetMeasurableCount} = yield* funnel.timeToPromotion();
	return {
		__typename: "FunnelSummary" as const,
		id: FUNNEL_SUMMARY_ID,
		caylakCount: population.caylakCount,
		yazarCount: population.yazarCount,
		promotionRate: promotionRate(population),
		firstContributionRate,
		vouchRate,
		timeToPromotionMedianMs: medianMs,
		timeToPromotionNotYetMeasurable: notYetMeasurableCount,
	};
});

export const queries = {
	"funnel.summary": Fate.query(
		{type: "FunnelSummary", error: Schema.Union([Denied])},
		Effect.fn("funnel.summary")(function* () {
			return yield* requireFunnelAccess(summaryGated());
		}),
	),
};
