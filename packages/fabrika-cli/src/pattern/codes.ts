/**
 * The one exit table all five `pattern` verbs allocate from, so a code means one thing across this
 * group whichever verb produced it (`claude-plugins/fabrika/skills/write-pattern/contract.md`).
 *
 * **The overlap with the base is imported, never restated** — the discipline `../exit-code-alignment.ts`
 * enforces and every aligned table follows: an aligning group imports the registry's constant, so a
 * drift is unrepresentable rather than merely detectable. The four seats come straight from
 * `../exit-codes.ts`, with `OFF_VOCABULARY` named locally over the registry's `CLASSIFIED` — this
 * group reads section names, not labels.
 *
 * This group shares four seats over `8`-`11` and adds `12`-`17` for facts about a doc, an index, a
 * one-row edit, and a supplied source checkout. `3`-`7` are deliberate gaps, each for a stated reason: no verb reads stdin (`3`),
 * none validates a doc's heading grammar (`4`), the repo's leak gate is the authority over
 * `.patterns/` (`5`), nothing composes a body from authored input (`6`) — and `7` `ZERO_SCOPE`
 * stays unseated because no verb here judges over a corpus, so none has a vacuous pass to prevent.
 * An empty or absent doc directory is a **fact** this group reports at exit `0`; refusing there
 * would leave a repo adopting fabrika unable to write its first pattern doc (#5254).
 *
 * `0`, `1`, `2` and `127` are reserved by the interface convention (`../verb.ts`, `../bin.ts`).
 */

import {
	CLASSIFIED as SHARED_CLASSIFIED,
	PRECONDITION_UNKNOWN as SHARED_PRECONDITION_UNKNOWN,
	READBACK_MISMATCH as SHARED_READBACK_MISMATCH,
	WRITE_UNKNOWN as SHARED_WRITE_UNKNOWN,
} from "../exit-codes.ts";

/** The write itself failed, so whether anything landed is UNKNOWN — deliberately not `1`. */
export const WRITE_UNKNOWN = SHARED_WRITE_UNKNOWN;
/** The write landed and the read-back does not match; the artifact exists and needs a human. */
export const READBACK_MISMATCH = SHARED_READBACK_MISMATCH;
/** A value is outside a closed set this group validates against — here, the index's section names. */
export const OFF_VOCABULARY = SHARED_CLASSIFIED;
/** A precondition read failed, so nothing was written and no outcome is proven. */
export const PRECONDITION_UNKNOWN = SHARED_PRECONDITION_UNKNOWN;

/** Proven: the named slug has no doc file. */
export const DOC_ABSENT = 12;
/** Proven: the target path already exists — refused, never overwritten. */
export const ALREADY_EXISTS = 13;
/**
 * The edit would have changed a line beyond the one row — aborted before writing.
 *
 * The load-bearing seat of the group. `.patterns/index.md` is hand-curated, carries prose between
 * its tables, and is edited by lanes `pattern register` cannot see, so an insertion that reflowed a
 * table or rewrote a neighbouring row would destroy work with no diff small enough to notice.
 */
export const MULTI_LINE_DIFF = 14;
/** Proven: the index is absent, or holds no parseable table. */
export const INDEX_UNPARSEABLE = 15;
/**
 * Proven: the named section matches more than one heading.
 *
 * Its own seat rather than {@link OFF_VOCABULARY}'s because the remedy differs: `10` says the flag
 * names a section that is not there, and this says the flag is right and the index needs
 * disambiguating.
 */
export const SECTION_AMBIGUOUS = 16;
/** Proven: a supplied source checkout cannot yield complete portable grounding evidence. */
export const SOURCE_REPOSITORY_REFUSED = 17;
