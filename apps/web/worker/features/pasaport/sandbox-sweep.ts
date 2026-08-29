/**
 * What a çaylak→yazar promotion's sandbox sweep un-hid — the live topics the swept rows
 * sit in, and the rows themselves (#6462, ADR 0314).
 *
 * The sweep clears `sandboxed_at` on the author's whole backlog, and `sandboxedInPlace`
 * is derived per-reader at read time, so the change cannot ride a payload: a viewer-blind
 * broadcast may not carry a viewer-derived field, and omitting the key is exactly what
 * leaves a subscriber's stale `true` standing. The only honest repair is to make them
 * re-read, and a subscriber can be holding a swept row two ways — through a connection or
 * by id — so both halves are carried. Neither replaces the other: an id-held row sits in
 * no connection, and a connection re-read repairs rows this sweep never names.
 *
 * `feed` is a boolean because the global `posts` connection is ONE topic however many
 * posts were swept; the other topic fields are keyed per topic and the id fields per row.
 */
export interface SandboxSweep {
	readonly feed: boolean;
	/** Parent post ids — the `Post.comments` topics. */
	readonly commentThreads: ReadonlyArray<string>;
	/** Term slugs — the `Term.definitions` topics. */
	readonly definitionTerms: ReadonlyArray<string>;
	/** Swept `Post` row ids. */
	readonly postIds: ReadonlyArray<string>;
	/** Swept `Comment` row ids. */
	readonly commentIds: ReadonlyArray<string>;
	/** Swept `Definition` row ids. */
	readonly definitionIds: ReadonlyArray<string>;
}

/** Nothing moved: an already-yazar re-fire, or a çaylak with an empty backlog. */
export const NO_SANDBOX_SWEEP: SandboxSweep = {
	feed: false,
	commentThreads: [],
	definitionTerms: [],
	postIds: [],
	commentIds: [],
	definitionIds: [],
};

/** How many sandboxed entries the sweep made public — the backlog-release moment's count (#7061). */
export const sweptEntryCount = (sweep: SandboxSweep): number =>
	sweep.postIds.length + sweep.commentIds.length + sweep.definitionIds.length;

/**
 * Lives beside the shape so a field added above cannot leave the publisher's early
 * return reading half of it.
 */
export const isEmptySweep = (sweep: SandboxSweep): boolean =>
	!sweep.feed &&
	sweep.commentThreads.length === 0 &&
	sweep.definitionTerms.length === 0 &&
	sweep.postIds.length === 0 &&
	sweep.commentIds.length === 0 &&
	sweep.definitionIds.length === 0;
