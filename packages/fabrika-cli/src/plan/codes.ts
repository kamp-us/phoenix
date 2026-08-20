/**
 * The one exit table the four `plan` verbs allocate from.
 *
 * Three tiers, and the tier decides how a constant gets here rather than what it means:
 *
 * - `3`–`11` are `report`'s seats, reached through `build`'s re-exports so there is one hop, not two
 *   tables to keep level. `ALIGNED_GROUPS` records the claim under `BUILD_SEATS` — *not*
 *   `SHARED_SEATS`, which omits `BAD_SECTIONS`: `plan read` seats `4`, so the checker would otherwise
 *   report it as a private code colliding with the base. {@link EMPTY_STDIN} is re-exported though no
 *   verb reaches it, because an omitted seat reads to the checker as drift.
 * - `15` is `build`'s, **imported verbatim**. This group holds a `build` claim, so a caller driving
 *   both in one sweep must read one meaning for it.
 * - `20`–`23` are this group's own.
 *
 * **Why `20`/`21` overlapping `build`'s `OUT_OF_SCOPE`/`AUDIENCE_NOT_AGENT` is safe (#5107).** The
 * contract seated these when `20`+ was free; the scope-admission fence has since taken both, and both
 * are reachable from `fabrika build claim`, which is step 1 of the skill that drives these verbs. The
 * `15` import argued that one code must carry one meaning across a sweep, so the question is fair —
 * and the answer is that the obligation the `15` import discharges is *not* the one at stake here.
 * `15` is imported because `plan flip` and `build claim` assert **the same fact** (this session holds
 * this issue's claim); two verbs proving one fact on two codes is the collision that bites. `20`/`21`
 * carry facts neither group's verbs can produce for the other: admission of an issue into a lane is
 * never something a `plan` verb proves, and a defective floor or a moved digest is never something a
 * `build` verb proves. An exit code is read off the command that produced it — nothing in
 * [SKILL.md](../../../../claude-plugins/fabrika/skills/check-epic-plan/SKILL.md) branches on `20`/`21`
 * from `build claim` (its step 1 is total: "any other non-zero ends `STOPPED`"), and it branches on
 * `20`/`21` only off `plan flip`/`plan verdict`. Re-seating at `24`+ would also buy nothing: `epic`
 * already seats `20`–`24` over `build`'s `20`/`21`, so there is no unoccupied band above the reserved
 * one and the alignment checker is base-only by design (interface convention rule 3). The rule this
 * group follows, stated so a later editor can apply it rather than re-derive it: **import a code when
 * two groups prove the same fact; allocate freely when they do not.**
 *
 * `0`, `1`, `2` and `127` are reserved by the interface convention (`../verb.ts`, `../bin.ts`).
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

/** Proven: the floor derived hard defects — refused as a precondition to writing, never as an answer. */
export const FLOOR_DEFECTIVE = 20;
/** Proven: the recomputed scope digest differs from the `--digest` the caller carried. */
export const PLAN_MOVED = 21;
/** Proven: at least one child is `unchanged` — the flip did not fully apply. */
export const PARTIAL_FLIP = 22;
/** Proven: a label the flip must write is absent from the repository's taxonomy (#4285). */
export const LABEL_ABSENT = 23;
/**
 * Proven: the invoking account may not approve this epic's plan — it is outside the
 * `@kamp-us/control-plane` roster resolved from CODEOWNERS at write time, or that roster names
 * nobody at all.
 *
 * Its own seat rather than `build`'s `GRANT_UNAUTHORIZED` (25), under the rule stated above: that
 * code proves an account may not clear a repair round on a PR, which is not this fact and which no
 * `plan` verb produces.
 */
export const APPROVAL_UNAUTHORIZED = 24;
