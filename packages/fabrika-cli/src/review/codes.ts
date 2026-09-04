/**
 * The one exit table all nine `review` verbs allocate from, so a code means one thing across this
 * group whichever verb produced it.
 *
 * **The overlap with `report` and `triage` is re-exported, never re-typed.** Where this group's
 * codes meet the shipped writing verbs' — `3`, `5`, `6`, `7`, `8`, `9`, `10`, `11` — the values are
 * *imported* from `../exit-codes.ts` and `../triage/codes.ts` rather than restated as numerals
 * here. A restated numeral is a second source that can drift silently; an import cannot, and the
 * checked-in `/report` contract already sits behind its own binary on `7` and `11` (#4752), which is
 * why the shipped package is the authority and no prose copy is.
 *
 * **`12`-`17` are this group's private band, and are deliberately not cleared against sibling
 * groups.** `triage` seats `12`/`13` on its own two refusals; that is two namespaces, not one
 * collision, because the `3`+ band carries no cross-group uniqueness obligation — see rule 3 of
 * `../../../../claude-plugins/fabrika/docs/cli-interface-convention.md`, which also names the one
 * condition that would change it. `../exit-code-alignment.ts` checks this band against the base
 * only, matching that scope.
 *
 * `0`, `1`, `2` and `127` are reserved by the interface convention (`../verb.ts`, `../bin.ts`).
 * `4` stays a deliberate gap — it is `report file`'s body-section seat, and no verb here performs
 * one; a row for it would be a meaning this group does not have.
 */

import {
	BARE_AT_PATH as SHARED_BARE_AT_PATH,
	EMPTY_STDIN as SHARED_EMPTY_STDIN,
	LEAKED_PATH as SHARED_LEAKED_PATH,
	NO_TARGET as SHARED_NO_TARGET,
	PRECONDITION_UNKNOWN as SHARED_PRECONDITION_UNKNOWN,
	READBACK_MISMATCH as SHARED_READBACK_MISMATCH,
	WRITE_UNKNOWN as SHARED_WRITE_UNKNOWN,
} from "../exit-codes.ts";
import {OFF_VOCABULARY as TRIAGE_OFF_VOCABULARY} from "../triage/codes.ts";

/** Stdin was read and held nothing. Distinct from a read that failed, which is `1`. */
export const EMPTY_STDIN = SHARED_EMPTY_STDIN;
/** The **authored** text carries a machine-local path. */
export const LEAKED_PATH = SHARED_LEAKED_PATH;
/** The **authored** text is a bare `@` path reference — not redactable, so a second code. */
export const BARE_AT_PATH = SHARED_BARE_AT_PATH;
/**
 * Zero scope: the target is **proven absent (404)** or closed, the PR has zero changed files or zero
 * declared check runs, or a required block is proven absent or malformed (ADR 0092).
 *
 * *Proven* is the operative word. A 404 is a fact about the repository; an unreachable GitHub is not
 * a fact about anything and lands on {@link PRECONDITION_UNKNOWN}.
 */
export const ZERO_SCOPE = SHARED_NO_TARGET;
/** The write itself failed — the outcome is **UNKNOWN**, deliberately not `1`. */
export const WRITE_UNKNOWN = SHARED_WRITE_UNKNOWN;
/** The write landed but the read-back does not match. The artifact exists and needs a human. */
export const READBACK_MISMATCH = SHARED_READBACK_MISMATCH;
/** A supplied classification value is off the closed vocabulary — namespace, polarity or carrier. */
export const OFF_VOCABULARY = TRIAGE_OFF_VOCABULARY;
/** A precondition read failed — nothing was written and the outcome is UNKNOWN. */
export const PRECONDITION_UNKNOWN = SHARED_PRECONDITION_UNKNOWN;

/**
 * Refused: the live head moved past the inspected `--sha`.
 *
 * The one code whose absence would let a verdict formed over one tree land on another — `bindToHead`'s
 * `Stale` arm applied at the write seam (#3769 / #4338's class, ADR 0058).
 */
export const STALE_HEAD = 12;
/**
 * Refused: the read completed and its scope is **provably incomplete**.
 *
 * Neither {@link PRECONDITION_UNKNOWN} (nothing failed) nor {@link ZERO_SCOPE} (scope exists; it just
 * was not all seen). Folding it into either renders a half-seen PR as a fully-judged one — the class
 * of #3925 and #4060.
 */
export const INCOMPLETE_SCAN = 13;
/** Refused: the invoking token resolves below `write`, or the ACL lookup failed (ADR 0055). */
export const ACL_DENIED = 14;
/** Refused: the write is not provably the prior rows plus one — the append-only fence. */
export const APPEND_ONLY = 15;
/**
 * Refused: the check runs at the head came from no workflow this repo authors.
 *
 * Neither {@link ZERO_SCOPE} (runs exist) nor {@link INCOMPLETE_SCAN} (all of them were seen). The
 * enumeration is complete and every run passed — and not one gate inspected the bytes, which is the
 * state that reads as safety while carrying none (#6522).
 */
export const NO_GATE_COVERAGE = 16;
/**
 * Refused: this post would retire a standing verdict of the OPPOSITE polarity at the same head, and
 * `--supersede` was not passed.
 *
 * Its own seat rather than {@link OFF_VOCABULARY}, because nothing about the arguments is off any
 * vocabulary — the write is legitimate and one flag away. What it costs is the record: a FAIL
 * overwritten by a PASS leaves nothing showing a gate ever blocked, and GitHub keeps no comment-body
 * history to recover it from (#7247). Nothing is written on this refusal.
 */
export const SUPERSEDES_VERDICT = 17;

/** The unallocated code — see the gap note at the top of this file. */
export const DELIBERATE_GAP = 4;
