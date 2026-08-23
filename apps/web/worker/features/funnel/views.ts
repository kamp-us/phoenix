/**
 * `FunnelSummary` — the conversion-funnel readout's one data view. The client
 * normalizes by `record.id`, so this singleton carries a stable synthetic `id`
 * (`"summary"`) and collapses to a single cache record, like `stats/LandingStats`.
 * See `.patterns/fate-effect-data-views.md`.
 */
import {FateDataView, type WorkerEntity} from "@kampus/fate-effect";
import type {ViewRow} from "../fate/view-types.ts";

interface FunnelSummaryRow {
	id: string;
	caylakCount: number;
	yazarCount: number;
	/** The three rates are fractions in `[0, 1]`. */
	promotionRate: number;
	firstContributionRate: number;
	vouchRate: number;
	/** `null` when no yazar is measurable yet (empty measured population). */
	timeToPromotionMedianMs: number | null;
	timeToPromotionNotYetMeasurable: number;
}

export type FunnelSummaryViewRow = ViewRow<FunnelSummaryRow>;

export class FunnelSummaryView extends FateDataView<FunnelSummaryViewRow>()("FunnelSummary")({
	id: true,
	caylakCount: true,
	yazarCount: true,
	promotionRate: true,
	firstContributionRate: true,
	vouchRate: true,
	timeToPromotionMedianMs: true,
	timeToPromotionNotYetMeasurable: true,
}) {}

export const funnelSummaryDataView = FunnelSummaryView.view;

export type FunnelSummary = WorkerEntity<typeof FunnelSummaryView>;

/**
 * `FunnelCohorts` — the cohort-section report (#7031, epic #6767): whether the cohort
 * display is enabled (the default-off `phoenix-funnel-cohort` flag resolves server-side)
 * plus the two known data holes as explicit counts (epic fact floor: the pre-#1590 founding
 * cohort and withdrawn/mod-free vouch evidence). The client normalizes by `record.id`, so
 * this singleton carries the stable synthetic id `"cohorts"`, like `FunnelSummary`. The
 * week rows themselves are the {@link FunnelCohortWeekView} lists, not fields here.
 */
interface FunnelCohortsRow {
	id: string;
	enabled: boolean;
	foundingPromotionsUnmeasurable: number;
	vouchEvidenceUnmeasurable: number;
}

export type FunnelCohortsViewRow = ViewRow<FunnelCohortsRow>;

export class FunnelCohortsView extends FateDataView<FunnelCohortsViewRow>()("FunnelCohorts")({
	id: true,
	enabled: true,
	foundingPromotionsUnmeasurable: true,
	vouchEvidenceUnmeasurable: true,
}) {}

export const funnelCohortsDataView = FunnelCohortsView.view;

export type FunnelCohorts = WorkerEntity<typeof FunnelCohortsView>;

/**
 * One per-signup-cohort week row of the cohort funnel (#7031) — the five stages within 7 days
 * of signup plus D1/D7 return counts and rates. Serves BOTH series: the live fold over existing
 * rows (`Funnel.cohorts`) and tracer B's durable weekly record (#7030, `Funnel.cohortRollups`).
 * `id` IS the UTC-Monday signup-week bucket (`"YYYY-MM-DD"`) — the stable key the client
 * normalizes by; rates are fractions in `[0, 1]`.
 *
 * Exported: the synthetic source pulls the row type across the composite project's
 * declaration boundary, where a private interface is unnameable (the TS4023 class).
 */
export interface FunnelCohortWeekRow {
	id: string;
	signedUp: number;
	returnedDays2to7: number;
	firstContributed7d: number;
	vouched7d: number;
	promoted7d: number;
	d1Returned: number;
	d7Returned: number;
	d1ReturnRate: number;
	d7ReturnRate: number;
}

export type FunnelCohortWeekViewRow = ViewRow<FunnelCohortWeekRow>;

export class FunnelCohortWeekView extends FateDataView<FunnelCohortWeekViewRow>()(
	"FunnelCohortWeek",
)({
	id: true,
	signedUp: true,
	returnedDays2to7: true,
	firstContributed7d: true,
	vouched7d: true,
	promoted7d: true,
	d1Returned: true,
	d7Returned: true,
	d1ReturnRate: true,
	d7ReturnRate: true,
}) {}

export const funnelCohortWeekDataView = FunnelCohortWeekView.view;

export type FunnelCohortWeek = WorkerEntity<typeof FunnelCohortWeekView>;
