/**
 * Optimistic-edit payload builders for the three Class-A content edits
 * (`post.edit` / `comment.edit` / `definition.edit`), gated by the
 * `phoenix-optimistic-edits` dark-ship flag (#1675, epic #1637). These edits are
 * entity-field write-backs that already re-render in place through their result
 * `view` — the only gap is that no `optimistic` partial is passed, so the UI
 * waits for the round-trip. Passing the partial renders the edited body/title
 * instantly; fate rolls it back on a rejected mutation and reconciles it against
 * the server `live.update({changed:[…]})` frame (same field → no divergence).
 *
 * Pure + hook-free (mirroring `voteOptimistic` in `useVoteToggle`) so the flag
 * gate and the fresh-`updatedAt` — which drives the "düzenlendi" indicator
 * (`EditedIndicator`) consistently with the reconciled frame — are unit-testable
 * apart from the fate mutation and React. See `.patterns/fate-mutations-client.md`.
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

/**
 * The optimistic partial for a post edit, or `undefined` when the dark-ship flag
 * is off — the pre-flag behavior: no `optimistic` payload, the UI waits for the
 * round-trip. `undefined` lets the call site spread it away under
 * `exactOptionalPropertyTypes` (`...(optimistic ? {optimistic} : {})`).
 */
export function postEditOptimistic(
	enabled: boolean,
	fields: {readonly title: string; readonly body: string},
	now: Now = defaultNow,
): PostEditOptimistic | undefined {
	return enabled ? {title: fields.title, body: fields.body, updatedAt: now()} : undefined;
}

/**
 * The optimistic partial for a comment/definition body edit, or `undefined` when
 * the dark-ship flag is off (see {@link postEditOptimistic}).
 */
export function bodyEditOptimistic(
	enabled: boolean,
	body: string,
	now: Now = defaultNow,
): BodyEditOptimistic | undefined {
	return enabled ? {body, updatedAt: now()} : undefined;
}
