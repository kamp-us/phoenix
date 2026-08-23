/**
 * `funnel.summary` + the cohort section (#7031, epic #6767) — the founder/mod conversion
 * readout's gated reads. The {@link requireFunnelAccess} capability gate (platform-moderation
 * only) guards each, so a non-mod read fails the invisible {@link Denied}; the cohort reads
 * then resolve behind the default-off `phoenix-funnel-cohort` flag, so the display ships dark
 * and can be enabled independently of the always-on capture (founder ruling R1.2 on #7028).
 *
 * `funnel.cohorts` is a synthetic singleton like `stats.landingStats`: the wire type is the
 * NAME string, not the view class, so the entity stays off the source-completeness path.
 */
import {Fate} from "@kampus/fate-effect";
import type {ConnectionResult} from "@nkzw/fate/server";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {PHOENIX_FUNNEL_COHORT} from "../../../src/flags/keys.ts";
import {Flags} from "../flagship/Flags.ts";
import {provideRequestFlags} from "../flagship/FlagsContext.ts";
import {Denied} from "../kunye/errors.ts";
import {Funnel, promotionRate} from "./Funnel.ts";
import {requireFunnelAccess, ViewFunnel} from "./gate.ts";
import type {FunnelCohortWeek} from "./views.ts";
import {FunnelCohortWeekView} from "./views.ts";

const FUNNEL_SUMMARY_ID = "summary";
const FUNNEL_COHORTS_ID = "cohorts";

/** The week lists take no arguments — the read is a full, ordered pass. */
const NoArgs = Schema.Struct({});

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

// Safe-default `false` — the cohort display ships dark.
const cohortDisplayOn = Effect.fn("funnel.cohortDisplayOn")(function* () {
	const flags = yield* Flags;
	return yield* flags.getBoolean(PHOENIX_FUNNEL_COHORT, false).pipe(provideRequestFlags);
});

/** The flag-off report row: no cohort read runs, and the client renders nothing. */
const disabledCohorts = () => ({
	__typename: "FunnelCohorts" as const,
	id: FUNNEL_COHORTS_ID,
	enabled: false,
	foundingPromotionsUnmeasurable: 0,
	vouchEvidenceUnmeasurable: 0,
});

const cohortsGated = Effect.fn("funnel.cohortsGated")(function* () {
	yield* ViewFunnel;
	if (!(yield* cohortDisplayOn())) return disabledCohorts();
	const funnel = yield* Funnel;
	const {unmeasurable} = yield* funnel.cohorts();
	return {
		__typename: "FunnelCohorts" as const,
		id: FUNNEL_COHORTS_ID,
		enabled: true,
		foundingPromotionsUnmeasurable: unmeasurable.foundingPromotionsUnmeasurable,
		vouchEvidenceUnmeasurable: unmeasurable.vouchEvidenceUnmeasurable,
	};
});

/** The week row is its own cursor: `id` IS the UTC-Monday signup-week bucket. */
const toWeekNode = (week: {
	readonly cohortWeek: string;
	readonly signedUp: number;
	readonly returnedDays2to7: number;
	readonly firstContributed7d: number;
	readonly vouched7d: number;
	readonly promoted7d: number;
	readonly d1Returned: number;
	readonly d7Returned: number;
	readonly d1ReturnRate: number;
	readonly d7ReturnRate: number;
}): FunnelCohortWeek => ({
	__typename: "FunnelCohortWeek",
	id: week.cohortWeek,
	signedUp: week.signedUp,
	returnedDays2to7: week.returnedDays2to7,
	firstContributed7d: week.firstContributed7d,
	vouched7d: week.vouched7d,
	promoted7d: week.promoted7d,
	d1Returned: week.d1Returned,
	d7Returned: week.d7Returned,
	d1ReturnRate: week.d1ReturnRate,
	d7ReturnRate: week.d7ReturnRate,
});

const emptyWeeks = (): ConnectionResult<FunnelCohortWeek> => ({
	items: [],
	pagination: {hasNext: false, hasPrevious: false},
});

const weeksConnection = (
	weeks: ReadonlyArray<FunnelCohortWeek>,
): ConnectionResult<FunnelCohortWeek> => ({
	items: weeks.map((week) => ({cursor: week.id, node: week})),
	pagination: {hasNext: false, hasPrevious: false},
});

const cohortWeeksGated = Effect.fn("funnel.cohortWeeksGated")(function* () {
	yield* ViewFunnel;
	if (!(yield* cohortDisplayOn())) return emptyWeeks();
	const funnel = yield* Funnel;
	return weeksConnection((yield* funnel.cohorts()).weeks.map(toWeekNode));
});

const cohortRollupsGated = Effect.fn("funnel.cohortRollupsGated")(function* () {
	yield* ViewFunnel;
	if (!(yield* cohortDisplayOn())) return emptyWeeks();
	const funnel = yield* Funnel;
	return weeksConnection((yield* funnel.cohortRollups()).map(toWeekNode));
});

export const queries = {
	"funnel.summary": Fate.query(
		{type: "FunnelSummary", error: Schema.Union([Denied])},
		Effect.fn("funnel.summary")(function* () {
			return yield* requireFunnelAccess(summaryGated());
		}),
	),
	"funnel.cohorts": Fate.query(
		{type: "FunnelCohorts", error: Schema.Union([Denied])},
		Effect.fn("funnel.cohorts")(function* () {
			return yield* requireFunnelAccess(cohortsGated());
		}),
	),
};

export const lists = {
	"funnel.cohortWeeks": Fate.list(
		{args: NoArgs, type: FunnelCohortWeekView, error: Schema.Union([Denied])},
		Effect.fn("funnel.cohortWeeks")(function* () {
			return yield* requireFunnelAccess(cohortWeeksGated());
		}),
	),
	"funnel.cohortRollups": Fate.list(
		{args: NoArgs, type: FunnelCohortWeekView, error: Schema.Union([Denied])},
		Effect.fn("funnel.cohortRollups")(function* () {
			return yield* requireFunnelAccess(cohortRollupsGated());
		}),
	),
};
