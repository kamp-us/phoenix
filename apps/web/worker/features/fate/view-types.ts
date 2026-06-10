/**
 * Shared type helpers for per-feature fate data-view modules
 * (`features/<feature>/views.ts`).
 *
 * Each feature's `views.ts` builds its `FateDataView` classes over a `ViewRow`
 * mapping of the service's row type. The mapping is byte-identical across
 * pano/sozluk/pasaport/stats, so it lives here once. See
 * `.patterns/fate-effect-data-views.md`.
 */

/**
 * Identity row mapping — restates a service row's shape as a plain object type.
 * Interfaces don't satisfy `FateDataView`'s `Record<string, unknown>` item
 * bound (no implicit index signature); the mapped type does, without repeating
 * the row's fields.
 */
export type ViewRow<Row> = {[K in keyof Row]: Row[K]};
