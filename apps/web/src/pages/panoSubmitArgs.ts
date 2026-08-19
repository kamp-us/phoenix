/**
 * The optimistic membership args for `post.submit`, split out of `PanoSubmitPage` so the
 * payload is unit-testable without a DOM. The feed is a registered root list, so this is
 * fate's documented happy path — see `.patterns/fate-mutations-client.md`.
 */

export interface OptimisticSubmitInput {
	readonly title: string;
	readonly url: string | null;
	readonly host: string | null;
	readonly tags: readonly string[];
	readonly author: string;
	readonly authorId: string;
	// Seeds the temp id and `createdAt`.
	readonly now: Date;
}

export function postSubmitMembership(input: OptimisticSubmitInput) {
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
