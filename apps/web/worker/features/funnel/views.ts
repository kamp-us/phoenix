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
