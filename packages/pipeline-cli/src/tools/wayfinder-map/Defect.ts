/**
 * The closed defect vocabulary the wayfinder-map floor validator emits, as Effect
 * Schema — the same idiom epic-ledger's `Defect.ts` establishes.
 *
 * `DEFECT_TYPES` is the single source of the closed enum; `DefectType` is its
 * `Schema.Literals` mirror and `Defect` the per-finding struct. The order of
 * `DEFECT_TYPES` is load-bearing: `validateMap` sorts its output by this order
 * first (then by issue ref), so the same map always yields the same defect
 * sequence — the determinism `mapSignature` and any downstream stall detection
 * depend on. Adding a type is a deliberate widening of the contract, not an
 * incidental edit.
 */
import * as Schema from "effect/Schema";

/**
 * The closed defect enum, in canonical emission order. The four `MISSING_*`
 * section defects lead — a map missing a required section is malformed at the
 * structural level, so those are the legible root causes and sort ahead of the
 * per-entry malformations. `EMPTY_DESTINATION` follows the section-presence block
 * (the destination heading exists but names no end-state — the map has no fixed
 * star to steer by). The three `MALFORMED_*_ENTRY` defects flag a list item that
 * carries no resolvable ref (a decision with no `— from #N` origin, a frontier or
 * fog line with no `#N`). `DANGLING_FRONTIER_REF` closes the set: a frontier
 * ticket that names an issue which is not a real sub-issue of the map — resolved
 * against the sub-issue set at the GitHub boundary, never by parsing.
 */
export const DEFECT_TYPES = [
	"MISSING_DESTINATION",
	"MISSING_DECISIONS_SECTION",
	"MISSING_FRONTIER_SECTION",
	"MISSING_FOG_SECTION",
	"EMPTY_DESTINATION",
	"MALFORMED_DECISION_ENTRY",
	"MALFORMED_FRONTIER_ENTRY",
	"MALFORMED_FOG_ENTRY",
	"DANGLING_FRONTIER_REF",
] as const;

export const DefectType = Schema.Literals(DEFECT_TYPES);
export type DefectType = (typeof DefectType)["Type"];

/** The rank of a defect type in canonical order — the primary validator sort key. */
export const defectTypeRank = (type: DefectType): number => DEFECT_TYPES.indexOf(type);

/**
 * One structural finding. `refs` carries the issue numbers the finding is about
 * (the frontier ticket's ref, the dangling ref, or the map's own number for a
 * section-level defect) — always present, sorted ascending, so a finding's
 * identity is stable regardless of input order.
 */
export const Defect = Schema.Struct({
	type: DefectType,
	message: Schema.String,
	refs: Schema.Array(Schema.Number),
});
export type Defect = (typeof Defect)["Type"];
