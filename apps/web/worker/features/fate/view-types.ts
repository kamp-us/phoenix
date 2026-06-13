/**
 * Shared type helper for per-feature fate data-view modules. See
 * `.patterns/fate-effect-data-views.md`.
 */

/**
 * Identity row mapping. Interfaces don't satisfy `FateDataView`'s
 * `Record<string, unknown>` item bound (no implicit index signature); this
 * mapped type does, without repeating the row's fields.
 */
export type ViewRow<Row> = {[K in keyof Row]: Row[K]};
