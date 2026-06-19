/**
 * The closed defect vocabulary the floor validator emits, as Effect Schema.
 *
 * `DEFECT_TYPES` is the single source of the closed enum; `DefectType` is its
 * `Schema.Literals` mirror and `Defect` the per-finding struct. The order of
 * `DEFECT_TYPES` is load-bearing: `validateLedger` sorts its output by this
 * order first (then by issue number), so the same ledger always yields the same
 * defect sequence — the determinism the downstream re-plan loop's stall
 * detection depends on. Adding a type is a deliberate widening of the contract,
 * not an incidental edit.
 */
import * as Schema from "effect/Schema";

/**
 * The closed defect enum, in canonical emission order. `ZERO_SCOPE` leads: it is
 * the floor's zero-scope=fail self-assertion (formats §ZS / ADR 0092) — an epic
 * that declares no linked children gave the validator *nothing to scan*, so the
 * floor fails closed instead of reading a silent clean PASS, and when it fires
 * every per-child defect below is moot (there are no children) so it is the
 * single legible root cause. `MISSING_STORIES_SECTION` is the epic-level "no
 * `### User stories` at all" defect — the story-side mirror of
 * `MISSING_DEPS_SECTION`; it leads the story cluster, and when it fires the
 * per-child `MISSING_STORY` is suppressed (the root cause is the epic, not each
 * child). `UNCOVERED_STORY` sits with the epic-scoped coverage defects (next to
 * `ORPHAN_CHILD`) and `MISSING_STORY` with the child-content defects (next to
 * `ZERO_AC`) — the two halves of the story-coverage invariant (ADR 0046/0047):
 * every declared story is covered by ≥1 child, every linked child traces to ≥1
 * story.
 */
export const DEFECT_TYPES = [
	"ZERO_SCOPE",
	"MISSING_DEPS_SECTION",
	"DEP_CYCLE",
	"DANGLING_DEP",
	"ORPHAN_CHILD",
	"MISSING_STORIES_SECTION",
	"UNCOVERED_STORY",
	"ZERO_AC",
	"MISSING_STORY",
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
