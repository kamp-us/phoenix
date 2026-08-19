/**
 * `LandingStats` — the landing-page counters card. The client normalizes by `record.id`, so
 * the entity carries a stable synthetic `id` (`"landing"`); there is only ever one row.
 * See `.patterns/fate-effect-data-views.md`.
 */
import {FateDataView, type WorkerEntity} from "@kampus/fate-effect";
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

export const landingStatsDataView = LandingStatsView.view;

export type LandingStats = WorkerEntity<typeof LandingStatsView>;
