/**
 * Stats fate data views — `LandingStats`.
 *
 * `LandingStats` — the landing-page counters card. A standalone entity (not a
 * relation) so it can be a `query` client root the SPA reads with `useRequest`.
 *
 * fate's codegen requires every `Root` entry to be a `dataView` with a type
 * name (`createSchema` calls `ensureType(view)` on each root), and the client
 * hardcodes `getId` to `record.id` for normalization — so the entity carries a
 * **stable synthetic `id`** (`"landing"`, stamped by `queries.landingStats`).
 * There's only ever one landing-stats row; the constant id makes it normalize
 * to a single cache record. The four counters + the build `version` are the
 * selectable surface; the SPA reads them directly.
 *
 * See `.patterns/fate-effect-data-views.md`.
 */
import {type Entity, FateDataView} from "@phoenix/fate-effect";
import type {ViewRow} from "../fate/view-types.ts";

interface LandingStatsRow {
	id: string;
	totalDefinitions: number;
	totalPosts: number;
	totalComments: number;
	totalAuthors: number;
	version: string;
}

/** Mapped restatement (`Record<string, unknown>`-assignable; see sozluk). */
export type LandingStatsViewRow = ViewRow<LandingStatsRow>;

export class LandingStatsView extends FateDataView<LandingStatsViewRow>()("LandingStats")({
	id: true,
	totalDefinitions: true,
	totalPosts: true,
	totalComments: true,
	totalAuthors: true,
	version: true,
}) {}

/**
 * The kernel view, for the cross-feature surfaces that want fate's plain
 * `dataView()` value (the `fate/views.ts` barrel + `Root`).
 */
export const landingStatsDataView = LandingStatsView.view;

// No `Replacements`: every field is a plain scalar (no Dates, no relations).
export type LandingStats = Entity<typeof LandingStatsView>;
