/**
 * The optimistic-vs-round-trip membership decision for `post.submit`, factored
 * out of {@link PanoSubmitPage} so the branch is unit-testable without a DOM (the
 * pure-core idiom of `flagGateChild` / `resolveFlagResponse`).
 *
 * The pano feed is a **registered root list** (no filter args), so this is fate's
 * documented happy path (`.patterns/fate-mutations-client.md`): with the
 * optimistic flag on, `insert: "before"` prepends a temp-id node that fate
 * reconciles to the server id when the real result arrives — the same server row
 * the `live.post.feed.appendNode` frame carries, so the mutator's own client sees
 * no double-row (reconcile dedups by server id). Gated behind the epic's
 * default-off containment flag (#1676, epic #1637): with the flag off, submit is
 * a plain round-trip (`insert: "none"`, no optimistic node) and the new post
 * appears only when the feed re-reads.
 */

/** The already-derived form + author values the optimistic node mirrors. */
export interface OptimisticSubmitInput {
	/** The trimmed post title. */
	readonly title: string;
	/** The link url in link mode, else `null`. */
	readonly url: string | null;
	/** The link host in link mode, else `null`. */
	readonly host: string | null;
	/** The selected tag kinds. */
	readonly tags: readonly string[];
	/** Display name for the author (name, falling back to email). */
	readonly author: string;
	/** The author's user id. */
	readonly authorId: string;
	/** The submit instant — seeds the temp id and `createdAt`. */
	readonly now: Date;
}

/**
 * The `post.submit` membership args: the optimistic prepend when the flag is on,
 * else a non-optimistic round-trip. Returned as a spread-in fragment so the call
 * site stays one `fate.mutations.post.submit({input, view, ...})`.
 */
export function postSubmitMembership(optimisticEnabled: boolean, input: OptimisticSubmitInput) {
	if (!optimisticEnabled) {
		// Off (default/safe) path: no client-side insert, no optimistic node — the
		// post lands in the feed only when the server row is read back.
		return {insert: "none" as const};
	}
	return {
		insert: "before" as const,
		optimistic: {
			id: `optimistic:${input.now.getTime()}`,
			slug: null,
			title: input.title,
			url: input.url,
			host: input.host,
			author: input.author,
			authorId: input.authorId,
			// Submitting a post is NOT a self-upvote: the server inserts it at score 0
			// with no viewer vote (Pano.submitPost). The optimistic record must mirror
			// that, else its score/myVote reconciles onto the server-id'd Post and
			// bleeds a phantom self-upvote into the freshly-navigated detail page (#707).
			score: 0,
			myVote: null,
			commentCount: 0,
			createdAt: input.now,
			tags: input.tags.map((kind) => ({kind, label: kind})),
		},
	};
}
