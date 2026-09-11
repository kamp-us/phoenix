/**
 * Exit allocations for `plan`; caller semantics are in `./command.ts` help.
 * Shared meanings are re-exported through `../build/codes.ts`. ALIGNED_GROUPS must use
 * BUILD_SEATS, which includes BAD_SECTIONS; EMPTY_STDIN stays exported for that alignment check.
 *
 * CLAIM_NOT_MINE is imported because plan and build prove the same claim fact. Private codes
 * may overlap across groups when those groups prove different facts. The producing command
 * identifies the meaning; allocation does not reserve a private band across the whole package.
 */

export {
	BAD_SECTIONS,
	BARE_AT_PATH,
	CLAIM_NOT_MINE,
	EMPTY_STDIN,
	LEAKED_PATH,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "../build/codes.ts";

export const FLOOR_DEFECTIVE = 20;
export const PLAN_MOVED = 21;
export const PARTIAL_FLIP = 22;
export const LABEL_ABSENT = 23;
/**
 * Proven: the invoking account may not approve this epic's plan — it is outside the control-plane
 * roster resolved from CODEOWNERS at write time, or that roster names nobody at all.
 *
 * Its own seat rather than `build`'s `GRANT_UNAUTHORIZED` (25), under the rule stated above: that
 * code proves an account may not clear a repair round on a PR, which is not this fact and which no
 * `plan` verb produces.
 */
export const APPROVAL_UNAUTHORIZED = 24;
/**
 * Proven: the plan is not approved as it now stands — the epic carries no standing approval marker,
 * or the marker's digest names a plan the epic has since moved off.
 *
 * Its own seat, refused **ahead of the floor**, and folded into nothing: a plan no human approved is
 * a different fact from a defective one, so neither {@link FLOOR_DEFECTIVE} nor {@link PLAN_MOVED}
 * may carry it. `PLAN_MOVED` is the nearest miss and still the wrong answer — it proves a
 * *caller's* `--digest` went stale between one verb and the next, which a re-check fixes, where this
 * proves a *founder's* reading went stale, which only a re-approval fixes.
 *
 * The seat is `25` rather than the `24` the brief named, because `APPROVAL_UNAUTHORIZED` took `24`
 * first; the rule is unchanged — allocate freely above the reserved band when no other group proves
 * the same fact, and `build`'s `GRANT_UNAUTHORIZED` (25) proves an account may not clear a repair
 * round, which no `plan` verb produces.
 */
export const PLAN_UNAPPROVED = 25;
/**
 * Proven: the epic body carries a `## Dependencies` heading that is not a machine-owned region —
 * more than one of them, or one sitting inside the preserved brief envelope.
 *
 * Its own seat rather than {@link ZERO_SCOPE}, because the two are opposite facts about a body: `7`
 * says there is no region to reconcile and the epic needs planning, this says there are bytes that
 * *look* like one and no way to tell which are the plan. Rewriting on a guess is how a body gets
 * destroyed, so the guess is refused instead.
 */
export const REGION_UNRESOLVABLE = 26;
/**
 * Proven: every issue the topology names closed without landing, so reconciling would leave no phase.
 *
 * Not an answer and not {@link REGION_UNRESOLVABLE} — the region parsed and its meaning was single.
 * The epic simply has no plan left, which a re-plan fixes and a rewrite cannot: writing the empty
 * block would erase the record of what was planned while leaving the epic just as unbuildable.
 */
export const TOPOLOGY_EMPTIED = 27;
