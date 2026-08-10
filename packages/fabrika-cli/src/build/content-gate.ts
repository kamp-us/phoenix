/**
 * The one door every externally-authorable byte a `build` verb returns passes through.
 *
 * Issue bodies, comment bodies, PR bodies, review findings — anything a party other than this process
 * wrote — is gated here before it reaches stdout. **Today the gate is provenance-stamping
 * pass-through: it changes no byte.** That is deliberate, not unfinished. The trust posture is an open
 * founder decision (#4859), and this module exists so that ruling lands as one module change covering
 * every verb at once, instead of an edit to five verbs that ships four of them.
 *
 * **TOCTOU is handled by construction, not by a cache invalidation rule.** No verb holds gated content
 * across invocations: every invocation re-fetches and re-gates, so a change to the posture below is in
 * force on the very next read. Nothing here memoizes, and nothing should.
 *
 * The provenance stamp is the part that is load-bearing *now*. A caller that has a {@link Gated} in
 * hand can say where the bytes came from without re-deriving it from the call site, which is what lets
 * a future posture refuse by origin rather than by pattern.
 */

/** Where the bytes came from — the axis a trust ruling would most plausibly turn on. */
export type ContentOrigin =
	/** An issue body, authored by whoever filed or edited the issue. */
	| "issue-body"
	/** A comment body on an issue or pull request. */
	| "comment-body"
	/** A pull-request body. */
	| "pull-body"
	/** A review's text on a pull request. */
	| "review-body";

/** Externally-authored text with its provenance attached. The `text` is what reaches stdout. */
export interface Gated {
	readonly origin: ContentOrigin;
	/** What the bytes describe — `#4312`, `comment 512001` — so a refusal could name it. */
	readonly locator: string;
	readonly text: string;
}

/**
 * Stamp externally-authored bytes with their provenance and hand them back.
 *
 * The identity on `text` is the whole of today's posture. It is **not** a claim that the bytes are
 * safe; it is the statement that fabrika has not yet ruled what to do about them, recorded in one
 * place rather than assumed in fourteen.
 */
export const gate = (origin: ContentOrigin, locator: string, text: string): Gated => ({
	origin,
	locator,
	text,
});

/** The gated bytes. Verbs read content through this rather than through the raw field. */
export const contentOf = (gated: Gated): string => gated.text;
