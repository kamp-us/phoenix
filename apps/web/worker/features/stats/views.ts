/**
 * `LandingStats` — the landing-page counters card, a standalone data view the
 * SPA reads with `useRequest`. The client normalizes by `record.id`, so the
 * entity carries a stable synthetic `id` (`"landing"`, stamped by
 * `queries.landingStats`) — there's only ever one row, so it collapses to a
 * single cache record. See `.patterns/fate-effect-data-views.md`.
 */
import {type Entity, FateDataView} from "@kampus/fate-effect";
import type {ViewRow} from "../fate/view-types.ts";

interface LandingStatsRow {
	id: string;
	totalDefinitions: number;
	totalPosts: number;
	totalComments: number;
	totalAuthors: number;
	version: string;
}

export type LandingStatsViewRow = ViewRow<LandingStatsRow>;

export class LandingStatsView extends FateDataView<LandingStatsViewRow>()("LandingStats")({
	id: true,
	totalDefinitions: true,
	totalPosts: true,
	totalComments: true,
	totalAuthors: true,
	version: true,
}) {}

// The kernel view, for cross-feature surfaces wanting fate's plain `dataView()`
// value (the `fate/views.ts` barrel + `Root`).
export const landingStatsDataView = LandingStatsView.view;

export type LandingStats = Entity<typeof LandingStatsView>;
