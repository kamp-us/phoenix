/**
 * `FunnelSummary` — the conversion-funnel readout's one data view (#1589): the
 * current tier population (çaylak + yazar counts) plus the headline promotion rate
 * (#1593) and the first-contribution rate (#1591) as a singleton entity the mod front
 * page reads with `useRequest`. The
 * client normalizes by `record.id`, so the
 * entity carries a stable synthetic `id` (`"summary"`, stamped by
 * `queries.funnelSummary`) — there's only ever one row, so it collapses to a single
 * cache record, exactly like `stats/LandingStats`. See
 * `.patterns/fate-effect-data-views.md`.
 */
import {FateDataView, type WorkerEntity} from "@kampus/fate-effect";
import type {ViewRow} from "../fate/view-types.ts";

interface FunnelSummaryRow {
	id: string;
	caylakCount: number;
	yazarCount: number;
	/** The headline promotion rate (#1593), a fraction in `[0, 1]`. */
	promotionRate: number;
	/** First-contribution rate (#1591): share of human çaylaks with ≥ 1 sandboxed contribution, in `[0, 1]`. */
	firstContributionRate: number;
	/** Vouch rate (#1592): share of human çaylaks who received ≥ 1 vouch (kefil), in `[0, 1]`. */
	vouchRate: number;
	/**
	 * Median registration→yazar time in ms (#1594), or `null` when no yazar is yet
	 * measurable (empty measured population).
	 */
	timeToPromotionMedianMs: number | null;
	/** Human yazars excluded from the median for a null `promoted_at` (#1594). */
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
