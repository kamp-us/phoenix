/**
 * The `Fate` namespace — the record-value constructors plus the two authoring
 * type helpers, per the PRD's five-export surface:
 *
 * ```ts
 * import {Fate} from "@phoenix/fate-effect";
 *
 * export const termSource = Fate.source(TermView, {id: "slug"}, {...});
 * type Term = Fate.Entity<typeof TermView>;
 * class BodyRequired extends Schema.TaggedErrorClass<BodyRequired>()(
 *   "sozluk/BodyRequired",
 *   {message: Schema.String},
 *   {[Fate.fateWireCode]: "BODY_REQUIRED"},
 * ) {}
 * ```
 *
 * The barrel exposes this module as `export * as Fate` — consumers reach the
 * constructors as `Fate.source` (and, from task 4 on, `Fate.query` /
 * `Fate.list` / `Fate.mutation`). Every member here is ALSO flat-exported from
 * the barrel: the flat names are what tsgo's declaration printer references
 * when a consumer exports a value built from them, and what the WireError
 * enumeration pin discovers over.
 */
export type {Entity} from "./DataView.ts";
export {source} from "./Source.ts";
export {fateWireCode} from "./WireError.ts";
