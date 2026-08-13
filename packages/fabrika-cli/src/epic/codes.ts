/**
 * The one exit table the eight `epic` verbs allocate from.
 *
 * Three tiers, and the tier decides how the constant gets here rather than what it means:
 *
 * - `3`-`11` are `report`'s seats, reached through `build`'s own re-exports so there is one hop, not
 *   two tables to keep level. `ALIGNED_GROUPS` records the claim; the import is what makes a drift
 *   unrepresentable rather than merely detectable.
 * - `13`-`19` are `build`'s, **imported verbatim** (`12` is `build`'s retired seat, so it is not among
 *   them). This group runs the same tree, lane and claim
 *   facts, and a caller driving `build` and `epic` in one sweep must read one meaning per code. That
 *   identity rides on the import itself — the alignment registry checks the overlap with the `report`
 *   base and cannot see this one, which is why it is stated here.
 * - `20`-`24` are this group's own: the genuinely-new facts a conductor has and no lane verb does.
 *
 * `5`, `6`, `16`, `17` and `19` are deliberately re-exported and never reached: no `epic` verb
 * authors prose to a public surface (`5`/`6`), and `eligible`/`push` own the rest. Carrying them
 * keeps the seats occupied with `build`'s meanings, so a later verb cannot re-seat one.
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

/** Proven: no run ledger exists for this epic + claim nonce — `epic open` has not run in this lane. */
export const NO_RUN = 20;
/**
 * Refused: the ledger reads, and holds state the model of the run cannot name.
 *
 * An off-enum event, a broken line, a `seq` regression. Separate from {@link NO_RUN} and from a read
 * that failed, because the repair differs: a run in a state nobody can name needs a human, and a
 * conductor that guessed past one is how a run gets stranded (#4145, #3929, #4555).
 */
export const UNNAMEABLE_STATE = 21;
/** Proven: HEAD is unchanged since the slice opened — a dead dispatch, distinct from a failed slice. */
export const NO_COMMIT = 22;
/** Proven: a retry breaker is tripped for the slice; the axis is named on stderr. */
export const BREAKER_TRIPPED = 23;
/** Proven: the named commit is not in this branch's local graph — nothing to diff, bind or verify. */
export const COMMIT_NOT_IN_GRAPH = 24;
