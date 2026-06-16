/**
 * The `Fate` namespace — the record-value and source constructors plus the
 * authoring type helpers: the whole authoring surface, exactly the exports
 * below.
 *
 * ```ts
 * import {Fate} from "@kampus/fate-effect";
 *
 * export const termSource = Fate.source(TermView, {id: "slug"}, {...});
 * type Term = Fate.Entity<typeof TermView>;
 * class BodyRequired extends Schema.TaggedErrorClass<BodyRequired>()(
 *   "sozluk/BodyRequired",
 *   {message: Schema.String},
 *   {[Fate.ErrorCode]: "BODY_REQUIRED"},
 * ) {}
 * ```
 *
 * The barrel exposes this module as `export * as Fate` — consumers reach the
 * constructors as `Fate.source` / `Fate.query` / `Fate.list` /
 * `Fate.mutation`. Every member here is ALSO flat-exported from the barrel:
 * the flat names are what tsgo's declaration printer references when a
 * consumer exports a value built from them, and what the WireError
 * enumeration pin discovers over.
 */
export type {Entity} from "./DataView.ts";
export {list, mutation, query} from "./Operation.ts";
export {source, syntheticSource} from "./Source.ts";
export {ErrorCode} from "./WireError.ts";
