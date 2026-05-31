/**
 * Shared type helpers for per-feature fate data-view modules
 * (`features/<feature>/views.ts`).
 *
 * Each feature's `views.ts` declares its entity views the same way — a `ViewRow`
 * mapping off the service's row type, a `DataViewOf` to type the `dataView(...)`
 * value, and an `EntityOf` to derive the exported `Entity<>` type from the row +
 * the selected fields. These three were byte-identical across pano/sozluk/
 * pasaport/stats; they live here so a change to the modeling convention is made
 * once. See `.patterns/per-feature-fate-aggregators.md` + `fate-data-views.md`.
 */
import type {SourceDefinition} from "@nkzw/fate/server";

/** Identity row mapping — restates a service row's shape as a plain object type. */
export type ViewRow<Row> = {[K in keyof Row]: Row[K]};

/** The `view` value type of a `SourceDefinition` over a given item row. */
export type DataViewOf<Item extends Record<string, unknown>> = SourceDefinition<Item>["view"];

/**
 * Derive an entity type from a row, the field-selection map, and the typename:
 * keep the row's value for each field selected `true`, and stamp `__typename`.
 */
export type EntityOf<Row, Fields, Name extends string> = {
	[K in keyof Fields as Fields[K] extends true ? K : never]: K extends keyof Row ? Row[K] : never;
} & {__typename: Name};
