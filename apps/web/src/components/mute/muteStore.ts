// The session-local optimistic overlay on top of the server read-mask, which stays the
// source of truth. An external store rather than a context so feed cards and the manage
// screen share one muted set across route changes without a provider in the tree.
//
// It holds no flag: an empty overlay is inert, and every consumer gates on the default-off
// `member-mute` flag before writing.

let mutedIds: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

export const withMember = (set: ReadonlySet<string>, id: string): ReadonlySet<string> => {
	if (set.has(id)) return set;
	const next = new Set(set);
	next.add(id);
	return next;
};

export const withoutMember = (set: ReadonlySet<string>, id: string): ReadonlySet<string> => {
	if (!set.has(id)) return set;
	const next = new Set(set);
	next.delete(id);
	return next;
};

export const subscribeMuteStore = (listener: () => void): (() => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};

export const muteStoreSnapshot = (): ReadonlySet<string> => mutedIds;

// The early return keeps the snapshot reference stable on a no-op; `useSyncExternalStore`
// re-renders on any new reference, so dropping it would churn every subscriber.
export const setMemberMuted = (id: string, muted: boolean): void => {
	const next = muted ? withMember(mutedIds, id) : withoutMember(mutedIds, id);
	if (next === mutedIds) return;
	mutedIds = next;
	for (const listener of listeners) listener();
};

export const resetMuteStore = (): void => {
	if (mutedIds.size === 0) return;
	mutedIds = new Set();
	for (const listener of listeners) listener();
};
