/**
 * The one exit table all five `spike` verbs allocate from, so a code means one thing across this
 * group whichever verb produced it (`claude-plugins/fabrika/skills/prototyping/contract.md`).
 *
 * The overlap with `report` is **re-exported, never re-typed**: an aligning group imports the base's
 * constant, so a drift is unrepresentable rather than merely detectable. This group claims all nine
 * seats over `3`-`11` — there is no `DELIBERATE_GAP` — and adds `12`-`21` for facts about a
 * throwaway workspace: whether it exists, where it resolves, what it recorded, and whether it stayed
 * thrown away.
 *
 * Three meanings on this table are one another's opposites and the whole group is built to keep them
 * apart: `1`/`127` is *the call never decided*, {@link READ_OR_EXEC_UNKNOWN} is *a read or an
 * execution failed and nothing was written*, and every code at `3` and above is something a verb
 * **proved** — with nothing on stdout.
 *
 * `0`, `1`, `2` and `127` are reserved by the interface convention (`../verb.ts`, `../bin.ts`).
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

/** Stdin was read and held nothing. `spike capture` only — the one verb that reads fd 0. */
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
/** The authored text is a bare `@` path reference — not redactable, so a second code. */
export const BARE_AT_PATH = SHARED_BARE_AT_PATH;
/**
 * Proven: the write target is absent — the spike issue, or the `prototyping:spike` label — or the
 * spike is proven closed when the verb needed it open.
 *
 * Never fused with {@link READ_OR_EXEC_UNKNOWN}: a proven absence is a verdict, a failed read is a
 * verdict about nothing, and no message in this group reads "does not exist, or is not readable".
 */
export const ZERO_SCOPE = SHARED_NO_TARGET;
/** A write was attempted and its outcome could not be proven — UNKNOWN, deliberately not `1`. */
export const WRITE_UNKNOWN = SHARED_WRITE_UNKNOWN;
/** The write landed but the read-back does not match; the artifact exists and needs a human. */
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
/** Proven: the resolved workspace path is inside the repository working tree — refused before any write. */
export const WORKSPACE_IN_TREE = 13;
/** Proven: the evidence log holds zero recorded runs — a decision here would be a self-report. */
export const NO_EVIDENCE = 14;
/** Proven: disposal was asked on a spike whose decision is not captured. */
export const NOT_CAPTURED = 15;
/** Proven: the workspace was removed and is still present on re-probe. */
export const REMOVAL_UNPROVEN = 16;
/** Proven: the working tree does not match what `spike open` recorded — the spike may have leaked. */
export const TREE_MOVED = 17;
/** Proven: the workspace for this nonce belongs to different work — another spike, question or kind. */
export const WORKSPACE_MISMATCH = 18;
/** Proven: the capture author does not hold `write` or better on the repository (ADR 0055). */
export const AUTHOR_UNAUTHORIZED = 19;
/** Proven: the spike issue landed and its manifest could not be completed to name it. */
export const MANIFEST_INCOMPLETE = 20;
/** Proven: the evidence log moved after the decision was captured — the capture no longer covers it. */
export const CAPTURE_STALE = 21;
