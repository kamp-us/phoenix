/**
 * The shown-once welcome marker (#7043, epic #4304).
 *
 * One persisted per-account fact — "this account has already been welcomed" — that both
 * the post-auth intercept in `App.tsx` and `WelcomePage` itself read. Keyed by user id so
 * accounts on one browser never suppress each other, and surviving reloads *and* repeat
 * logins, which is what "once per account" (#4266) means here.
 *
 * Client-side by design: the welcome surface and its intercept are client seams, and no
 * worker write path belongs to this slice. A browser that refuses storage degrades to
 * "never seen" — the welcome may show again, but nothing breaks.
 *
 * DOM-free (storage is injected) so the suppression contract is unit-testable without a
 * document, mirroring `fate/snapshot.ts`.
 */

/** Bumped to force every persisted marker stale. */
export const WELCOME_SEEN_SCHEMA = "v1";

const WELCOME_SEEN_VALUE = "1";

export interface WelcomeStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

export function welcomeSeenKey(schema: string, userId: string): string {
	return `welcome-seen:${schema}:user:${userId}`;
}

export function hasSeenWelcome(storage: WelcomeStorage | null, userId: string | null): boolean {
	if (!storage || !userId) return false;
	return storage.getItem(welcomeSeenKey(WELCOME_SEEN_SCHEMA, userId)) === WELCOME_SEEN_VALUE;
}

/** Idempotent; a failed write stays silent — losing the marker only re-shows the welcome. */
export function markWelcomeSeen(storage: WelcomeStorage | null, userId: string | null): void {
	if (!storage || !userId) return;
	try {
		storage.setItem(welcomeSeenKey(WELCOME_SEEN_SCHEMA, userId), WELCOME_SEEN_VALUE);
	} catch {
		// Private mode / quota: degrade to "not marked", never break the arrival.
	}
}

/**
 * `null` when unavailable — Safari private mode throws on `window.localStorage` access,
 * and SSR/boot has no window at all (same defensive shape as `fate/snapshot.ts`).
 */
export function welcomeStorage(): WelcomeStorage | null {
	if (typeof window === "undefined") return null;
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}
