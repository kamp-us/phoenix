/**
 * The one exit table all four `graduate` verbs allocate from, so a code means one thing across this
 * group whichever verb produced it (`claude-plugins/fabrika/skills/graduate/contract.md`).
 *
 * The overlap with `report` is **re-exported, never re-typed**: an aligning group imports the base's
 * constant, so a drift is unrepresentable rather than merely detectable. This group shares all nine
 * seats over `3`-`11` — it is one of the few that reaches every one of them, including `10`, which is
 * load-bearing here rather than a courtesy: ADR 0246 forbids this group writing board state, and `10`
 * is that prohibition made mechanical against a classifying `--title`.
 *
 * `12`-`18` are the group's own and clear the base's occupied seats. They carry no cross-group
 * uniqueness obligation, so `review`'s `12` and this group's `12` are two namespaces rather than a
 * collision.
 *
 * Two stated widenings of imported seats, both narrowing the condition without moving the meaning:
 * `5` fires unconditionally because no verb here offers `--redact`, and `7` covers a **named** target
 * rather than only a write target — `graduate trail` and `graduate read` write nothing at all and
 * seat `7` on a source issue proven absent.
 *
 * `0`, `1`, `2`, `126` and `127` are reserved by the interface convention (`../verb.ts`).
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

/** Stdin was read and held nothing. `graduate compose` only — the one verb that reads fd 0. */
export const EMPTY_STDIN = SHARED_EMPTY_STDIN;
/** An authored section is missing, out of order, or empty; or a map body that does not parse. */
export const BAD_SECTIONS = SHARED_BAD_SECTIONS;
/** The text carries a machine-local path. No verb here offers `--redact`, so it fires always. */
export const LEAKED_PATH = SHARED_LEAKED_PATH;
/** The text is a bare `@` path reference — not redactable, so a second code. */
export const BARE_AT_PATH = SHARED_BARE_AT_PATH;
/** Proven: the named target does not exist — the source issue, or the `status:needs-triage` label. */
export const NO_TARGET = SHARED_NO_TARGET;
/** A write was attempted and its outcome could not be proven — UNKNOWN, deliberately not `1`. */
export const WRITE_UNKNOWN = SHARED_WRITE_UNKNOWN;
/** The write landed but the read-back differs; the artifact exists and needs a human. */
export const READBACK_MISMATCH = SHARED_READBACK_MISMATCH;
/** Proven: `--title` carries a type or priority classification. Triage's seat, not this group's. */
export const CLASSIFIED = SHARED_CLASSIFIED;
/** A precondition read failed, so nothing was written and no outcome is proven. */
export const PRECONDITION_UNKNOWN = SHARED_PRECONDITION_UNKNOWN;

/** Proven: the issue carries neither `grilling:session` nor `wayfinding:map`, or carries both. */
export const SOURCE_UNRECOGNIZED = 12;
/**
 * Proven: the trail holds an unresolved decision.
 *
 * A refusal rather than a warning, and it lives in the verb rather than in skill prose so it holds
 * even when the skill's own step is skipped: a spec synthesized over a decision nobody made is the
 * #4110 failure this seat exists to refuse.
 */
export const TRAIL_BLOCKED = 13;
/** Proven: a decision entry is missing a digested field, or `--trail` carries no 12-hex digest. */
export const DIGEST_UNBINDABLE = 14;
/** Proven: this **spec** digest already emitted an issue. A different subset may still graduate. */
export const ALREADY_GRADUATED = 15;
/** Proven: the trail holds zero decisions — there is nothing to synthesize. */
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
