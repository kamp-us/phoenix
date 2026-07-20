/**
 * Optimistic-edit payload builders for the three Class-A content edits
 * (`post.edit` / `comment.edit` / `definition.edit`). These edits are
 * entity-field write-backs that already re-render in place through their result
 * `view`; passing the partial renders the edited body/title instantly, and fate
 * rolls it back on a rejected mutation and reconciles it against the server
 * `live.update({changed:[…]})` frame (same field → no divergence).
 *
 * Pure + hook-free (mirroring `voteOptimistic` in `useVoteToggle`) so the
 * fresh-`updatedAt` — which drives the "düzenlendi" indicator (`EditedIndicator`)
 * consistently with the reconciled frame — is unit-testable apart from the fate
 * mutation and React. See `.patterns/fate-mutations-client.md`.
 */

/** Injectable now-clock so the optimistic `updatedAt` is deterministic in tests. */
export type Now = () => Date;

const defaultNow: Now = () => new Date();

/** `post.edit` optimistic partial — the edited title/body + a fresh `updatedAt`. */
export interface PostEditOptimistic {
	readonly title: string;
	readonly body: string;
	readonly updatedAt: Date;
}

/** `comment.edit` / `definition.edit` optimistic partial — edited body + fresh `updatedAt`. */
export interface BodyEditOptimistic {
	readonly body: string;
	readonly updatedAt: Date;
}

/** The optimistic partial for a post edit — the edited title/body + a fresh `updatedAt`. */
export function postEditOptimistic(
	fields: {readonly title: string; readonly body: string},
	now: Now = defaultNow,
): PostEditOptimistic {
	return {title: fields.title, body: fields.body, updatedAt: now()};
}

/** The optimistic partial for a comment/definition body edit (see {@link postEditOptimistic}). */
export function bodyEditOptimistic(body: string, now: Now = defaultNow): BodyEditOptimistic {
	return {body, updatedAt: now()};
}
