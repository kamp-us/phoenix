/**
 * What a çaylak→yazar promotion's sandbox sweep un-hid, named by live topic rather than
 * by row (#6462).
 *
 * The sweep clears `sandboxed_at` on the author's whole backlog, and `sandboxedInPlace`
 * is derived per-reader at read time, so the change cannot ride an entity payload: a
 * viewer-blind broadcast may not carry a viewer-derived field, and omitting the key is
 * exactly what leaves a subscriber's stale `true` standing. The only honest repair is to
 * make them re-read, so this carries the connection topics to invalidate.
 *
 * `feed` is a boolean because the global `posts` connection is ONE topic however many
 * posts were swept; the other two are keyed per topic.
 */
export interface SandboxSweep {
	readonly feed: boolean;
	/** Parent post ids — the `Post.comments` topics. */
	readonly commentThreads: ReadonlyArray<string>;
	/** Term slugs — the `Term.definitions` topics. */
	readonly definitionTerms: ReadonlyArray<string>;
}

/** Nothing moved: an already-yazar re-fire, or a çaylak with an empty backlog. */
export const NO_SANDBOX_SWEEP: SandboxSweep = {
	feed: false,
	commentThreads: [],
	definitionTerms: [],
};
