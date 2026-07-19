/**
 * The funnel root query resolver (#1589) — `funnel.summary`, the founder/mod
 * conversion readout's single gated read.
 *
 * The {@link requireFunnelAccess} capability gate — platform-moderation only —
 * guards the read: `yield* ViewFunnel` makes it unreachable without the discharged
 * grant, so a non-mod read fails the invisible {@link Denied}.
 *
 * A synthetic singleton like `stats.landingStats`: the wire type is the NAME string
 * (`"FunnelSummary"`), not the view class, so the entity stays off the source-
 * completeness path (the resolver is its only producer, no by-id fetch). Codegen is
 * unchanged — the client root types off `Root`'s `funnelSummaryDataView` + this
 * handler.
 */
import {Fate} from "@kampus/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {Denied} from "../kunye/errors.ts";
import {Funnel, promotionRate} from "./Funnel.ts";
import {requireFunnelAccess, ViewFunnel} from "./gate.ts";

const FUNNEL_SUMMARY_ID = "summary";

// The post-gate summary read — `ViewFunnel`-gated in R (`requireFunnelAccess`
// provides the grant). `yield* ViewFunnel` requires the proof; the counts are
// unreachable without a discharged grant.
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
