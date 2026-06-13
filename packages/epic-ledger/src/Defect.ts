/**
 * The closed defect vocabulary the floor validator emits, as Effect Schema.
 *
 * `DEFECT_TYPES` is the single source of the 7-member enum; `DefectType` is its
 * `Schema.Literals` mirror and `Defect` the per-finding struct. The order of
 * `DEFECT_TYPES` is load-bearing: `validateLedger` sorts its output by this
 * order first (then by issue number), so the same ledger always yields the same
 * defect sequence — the determinism the downstream re-plan loop's stall
 * detection depends on. Adding a type is a deliberate widening of the contract,
 * not an incidental edit.
 */
import * as Schema from "effect/Schema";

/** The closed 7-type defect enum, in canonical emission order. */
export const DEFECT_TYPES = [
	"MISSING_DEPS_SECTION",
	"DEP_CYCLE",
	"DANGLING_DEP",
	"ORPHAN_CHILD",
	"ZERO_AC",
	"MISSING_LABEL",
	"NEEDS_TRIAGE_LABEL",
] as const;

export const DefectType = Schema.Literals(DEFECT_TYPES);
export type DefectType = (typeof DefectType)["Type"];

/** The rank of a defect type in canonical order — the primary validator sort key. */
export const defectTypeRank = (type: DefectType): number => DEFECT_TYPES.indexOf(type);

/**
 * One structural finding. `refs` carries the issue numbers the finding is about
 * (a cycle's members, a dangling edge's source/target, the child missing a
 * label) — always present, sorted ascending, so a finding's identity is stable
 * regardless of the order the ledger presented its inputs.
 */
export const Defect = Schema.Struct({
	type: DefectType,
	message: Schema.String,
	refs: Schema.Array(Schema.Number),
});
export type Defect = (typeof Defect)["Type"];
