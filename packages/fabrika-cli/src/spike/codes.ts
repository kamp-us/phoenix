/**
 * Exit allocations for `spike`; caller semantics are in `./command.ts` help.
 * Shared meanings import `../exit-codes.ts`; allocation checks live in `../exit-code-alignment.ts`.
 */

import {
	BAD_SECTIONS as SHARED_BAD_SECTIONS,
	BARE_AT_PATH as SHARED_BARE_AT_PATH,
	CLASSIFIED as SHARED_CLASSIFIED,
	EMPTY_STDIN as SHARED_EMPTY_STDIN,
	LEAKED_PATH as SHARED_LEAKED_PATH,
	NO_TARGET as SHARED_NO_TARGET,
	PRECONDITION_UNKNOWN as SHARED_PRECONDITION_UNKNOWN,
	READBACK_MISMATCH as SHARED_READBACK_MISMATCH,
	WRITE_UNKNOWN as SHARED_WRITE_UNKNOWN,
} from "../exit-codes.ts";

export const EMPTY_STDIN = SHARED_EMPTY_STDIN;
/**
 * A required document is missing, malformed, or out of place — here the workspace manifest or the
 * evidence log exists and does not parse.
 *
 * Refused whole-file rather than per-field: a verb holding half a manifest would compare against a
 * digest it cannot vouch for.
 */
export const MALFORMED_RECORD = SHARED_BAD_SECTIONS;
/**
 * The authored text carries a machine-local path.
 *
 * **A stated widening of the base seat, which reads "…and `--redact` was not given".** No `spike`
 * verb offers `--redact`, so here the refusal fires unconditionally. The condition narrows; the
 * meaning does not drift.
 */
export const LEAKED_PATH = SHARED_LEAKED_PATH;
export const BARE_AT_PATH = SHARED_BARE_AT_PATH;
/**
 * Proven: the write target is absent — the spike issue, or the `prototyping:spike` label — or the
 * spike is proven closed when the verb needed it open.
 *
 * Never fused with {@link READ_OR_EXEC_UNKNOWN}: a proven absence is a verdict, a failed read is a
 * verdict about nothing, and no message in this group reads "does not exist, or is not readable".
 */
export const ZERO_SCOPE = SHARED_NO_TARGET;
export const WRITE_UNKNOWN = SHARED_WRITE_UNKNOWN;
export const READBACK_MISMATCH = SHARED_READBACK_MISMATCH;
/**
 * A value off its closed vocabulary or naming grammar — an off-grammar `--nonce`, a `--kind` outside
 * `logic`/`ui`, a malformed `--timeout` or `--env`.
 *
 * A semantic refusal on a *value*; a malformed *flag* stays `1`, which is the parser's.
 */
export const OFF_VOCABULARY = SHARED_CLASSIFIED;
/**
 * A required read or execution failed — no outcome is proven.
 *
 * **The name differs from the base's `PRECONDITION_UNKNOWN` deliberately.** The base covers a failed
 * precondition *read*; this seat also covers a child process that could not be *executed*, which is
 * an attempt rather than a read. `../exit-code-alignment.ts` records that a group's reading may be a
 * documented superset and that a number cannot say so on its own; the name is where this one says it.
 */
export const READ_OR_EXEC_UNKNOWN = SHARED_PRECONDITION_UNKNOWN;

/**
 * Proven: no workspace exists for this nonce — never opened, or already disposed.
 *
 * Deliberately not {@link ZERO_SCOPE}: an absent workspace is a routable local state, not a
 * statement about the issue.
 */
export const NO_WORKSPACE = 12;
export const WORKSPACE_IN_TREE = 13;
export const NO_EVIDENCE = 14;
export const NOT_CAPTURED = 15;
export const REMOVAL_UNPROVEN = 16;
export const TREE_MOVED = 17;
export const WORKSPACE_MISMATCH = 18;
export const AUTHOR_UNAUTHORIZED = 19;
export const MANIFEST_INCOMPLETE = 20;
export const CAPTURE_STALE = 21;
