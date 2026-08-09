/**
 * The one exit table the six `ledger` verbs allocate from.
 *
 * Three tiers, and the tier decides how a constant gets here rather than what it means:
 *
 * - `3`–`11` are `report`'s seats, reached through `build`'s re-exports so there is one hop, not two
 *   tables to keep level. `ALIGNED_GROUPS` records the claim under `BUILD_SEATS` — *not*
 *   `SHARED_SEATS`, which omits `BAD_SECTIONS`: three verbs here seat `4`, so under `SHARED_SEATS`
 *   the checker would report `4` as a private code colliding with the base.
 * - `12`–`19` are `build`'s, **re-exported verbatim**, because this group asserts the identical facts
 *   (this process is in a linked worktree; this session holds this issue's claim) and a caller driving
 *   both in one sweep must read one meaning for each. The re-export is selective and stops at `19`:
 *   `13`, `14`, `16`, `17`, `18` and `19` are **never reached here** — this skill declares no
 *   `--require-clean` flag, holds no lane branch, pushes nothing, runs no validation and derives no
 *   readiness verdict — but carrying them keeps those seats occupied so a later verb here cannot
 *   re-seat one.
 * - `20`–`26` are this group's own. `build`'s `20`/`21` are deliberately **not** re-exported:
 *   re-exporting `OUT_OF_FOCUS`/`AUDIENCE_NOT_AGENT` alongside these would put two names on one code in
 *   one module, which `allocatedCodes` reports as drift. The rule this group follows, taken from
 *   `plan/codes.ts` rather than re-derived: **import a code when two groups prove the same fact;
 *   allocate freely when they do not.** No `build`, `epic` or `plan` verb can prove a fact about a
 *   *plan being authored*, and an exit code is read off the command that produced it.
 *
 * `0`, `1`, `2` and `127` are reserved by the interface convention (`../verb.ts`, `../bin.ts`).
 */

export {
	BAD_SECTIONS,
	BARE_AT_PATH,
	BLOCKED,
	CLAIM_NOT_MINE,
	DIRTY_TREE,
	EMPTY_STDIN,
	LEAKED_PATH,
	NOT_A_WORKTREE,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	REF_NOT_MOVED,
	UNSAFE_PUSH,
	VALIDATION_RED,
	WRITE_UNKNOWN,
	WRONG_LANE,
	ZERO_SCOPE,
} from "../build/codes.ts";

/** Proven: the worktree's base is behind `origin/main` — a plan derived here is derived on stale ground. */
export const STALE_GROUND = 20;
/** Proven: the epic body moved — the recomputed digest differs from `--body-digest`. */
export const EPIC_MOVED = 21;
/** Proven: the plan region is unresolvable — a duplicated anchor, or a mode the body contradicts. */
export const REGION_UNRESOLVABLE = 22;
/**
 * Proven: the child was created and its sub-issue link could not be proven.
 *
 * Narrower and more useful than {@link WRITE_UNKNOWN} or {@link READBACK_MISMATCH}: the create is
 * proven and the *link* is unknown, so a named child exists unlinked. Fusing it into `8` would leave a
 * successor unable to tell "something may exist" from "#4302 exists and needs linking".
 */
export const LINK_UNPROVEN = 23;
/** Proven: the declared topology is invalid — a cycle, a dangling ref, or an unplaced child. */
export const TOPOLOGY_INVALID = 24;
/** Proven: a document this verb must splice was never staged in this run. */
export const NOT_STAGED = 25;
/** Proven: a child was created and the run manifest could not record it. */
export const MANIFEST_UNWRITTEN = 26;
