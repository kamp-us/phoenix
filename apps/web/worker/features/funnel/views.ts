/**
 * `FunnelSummary` — the conversion-funnel readout's one data view (#1589): the
 * current tier population (çaylak + yazar counts) plus the headline promotion rate
 * (#1593) as a singleton entity the mod front page reads with `useRequest`. The
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
}

export type FunnelSummaryViewRow = ViewRow<FunnelSummaryRow>;

export class FunnelSummaryView extends FateDataView<FunnelSummaryViewRow>()("FunnelSummary")({
	id: true,
	caylakCount: true,
	yazarCount: true,
	promotionRate: true,
}) {}

export const funnelSummaryDataView = FunnelSummaryView.view;

export type FunnelSummary = WorkerEntity<typeof FunnelSummaryView>;
