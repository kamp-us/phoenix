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
 * See `.patterns/fate-data-views.md`.
 */
import type {SourceDefinition} from "@nkzw/fate/server";
import {dataView} from "@nkzw/fate/server";

type DataViewOf<Item extends Record<string, unknown>> = SourceDefinition<Item>["view"];

type EntityOf<Row, Fields, Name extends string> = {
	[K in keyof Fields as Fields[K] extends true ? K : never]: K extends keyof Row ? Row[K] : never;
} & {__typename: Name};

interface LandingStatsViewRow {
	[k: string]: unknown;
	id: string;
	totalDefinitions: number;
	totalPosts: number;
	totalComments: number;
	totalAuthors: number;
	version: string;
}

const landingStatsFields = {
	id: true,
	totalDefinitions: true,
	totalPosts: true,
	totalComments: true,
	totalAuthors: true,
	version: true,
} as const;

export const landingStatsDataView: DataViewOf<LandingStatsViewRow> =
	dataView<LandingStatsViewRow>("LandingStats")(landingStatsFields);

export type LandingStats = EntityOf<LandingStatsViewRow, typeof landingStatsFields, "LandingStats">;
