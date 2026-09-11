/**
 * Exit allocations for `graduate`; caller semantics are in `./command.ts` help.
 * Shared meanings import `../exit-codes.ts`. Title classification is checked here because
 * typing and prioritizing an issue belong to triage.
 *
 * The imported path check is unconditional because this group offers no redaction.
 * NO_TARGET also covers read-only named targets, not only write targets.
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
export const BAD_SECTIONS = SHARED_BAD_SECTIONS;
export const LEAKED_PATH = SHARED_LEAKED_PATH;
export const BARE_AT_PATH = SHARED_BARE_AT_PATH;
export const NO_TARGET = SHARED_NO_TARGET;
export const WRITE_UNKNOWN = SHARED_WRITE_UNKNOWN;
export const READBACK_MISMATCH = SHARED_READBACK_MISMATCH;
export const CLASSIFIED = SHARED_CLASSIFIED;
export const PRECONDITION_UNKNOWN = SHARED_PRECONDITION_UNKNOWN;

export const SOURCE_UNRECOGNIZED = 12;
/**
 * Proven: the trail holds an unresolved decision.
 *
 * A refusal rather than a warning, and it lives in the verb rather than in skill prose so it holds
 * even when the skill's own step is skipped: a spec synthesized over a decision nobody made is work
 * proceeding past a choice nobody took, and that is the failure this seat exists to refuse.
 */
export const TRAIL_BLOCKED = 13;
export const DIGEST_UNBINDABLE = 14;
export const ALREADY_GRADUATED = 15;
export const TRAIL_EMPTY = 16;
/**
 * Proven: the stdin body carries a `## Decisions` heading.
 *
 * Deliberately not {@link BAD_SECTIONS}: the authored sections may be perfectly well-formed. What is
 * wrong is *who wrote which section* — that one is rendered from the trail and never authored.
 */
export const DECISIONS_AUTHORED = 17;
/**
 * Proven: a ref the spec carries is absent from the re-derived trail, or its provenance or text has
 * changed; or a `## Decisions` line does not parse.
 *
 * The section is machine-rendered at both ends, so a line that will not parse means the body was
 * edited by hand.
 */
export const DECISIONS_STALE = 18;
