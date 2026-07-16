/**
 * Client session-local muted-member overlay for member-mute (sustur, #3117, epic #2035).
 *
 * The SERVER read-mask (#3113) is the source of truth for a viewer's persisted mutes; this
 * store is the optimistic overlay that gives immediate in-session feedback: a member the
 * viewer just muted disappears from the current feed before any refetch, and one just
 * unmuted returns. A tiny external store (read via `useSyncExternalStore`) rather than a
 * context so the feed cards and the manage screen share one muted set across route changes
 * without threading a provider through the app tree.
 *
 * The store holds no flag — an empty overlay is inert, so a session with the default-off
 * `member-mute` flag simply never writes to it (every consumer gates on the flag first).
 */

let mutedIds: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

/** Add a member to a muted set, returning a new set (never mutating the input). */
export const withMember = (set: ReadonlySet<string>, id: string): ReadonlySet<string> => {
	if (set.has(id)) return set;
	const next = new Set(set);
	next.add(id);
	return next;
};

/** Remove a member from a muted set, returning a new set (never mutating the input). */
export const withoutMember = (set: ReadonlySet<string>, id: string): ReadonlySet<string> => {
	if (!set.has(id)) return set;
	const next = new Set(set);
	next.delete(id);
	return next;
};

/** Subscribe to muted-set changes (the `useSyncExternalStore` subscribe half). */
export const subscribeMuteStore = (listener: () => void): (() => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};

/** The current muted set — a stable reference until the next mutation (getSnapshot half). */
export const muteStoreSnapshot = (): ReadonlySet<string> => mutedIds;

/**
 * Set a member's muted presence in the overlay. A no-op when the state already matches, so
 * the snapshot reference stays stable (no spurious re-render). Notifies subscribers only on
 * an actual change.
 */
export const setMemberMuted = (id: string, muted: boolean): void => {
	const next = muted ? withMember(mutedIds, id) : withoutMember(mutedIds, id);
	if (next === mutedIds) return;
	mutedIds = next;
	for (const listener of listeners) listener();
};

/** Clear the overlay — test hygiene (each test starts from an empty set). */
export const resetMuteStore = (): void => {
	if (mutedIds.size === 0) return;
	mutedIds = new Set();
	for (const listener of listeners) listener();
};
