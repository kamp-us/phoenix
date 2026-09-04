/**
 * The per-account browser marker both onboarding one-shots are expressed on — the
 * welcome's shown-once (#7043) and the first-contribution nudge's dismissal (#7044).
 * One mechanism, so a second one-shot cannot invent a differently-keyed variant.
 *
 * Client-side by design: the welcome surface and its exit are client seams, and no
 * worker write path belongs to this slice. DOM-free (storage is injected) so each
 * marker's contract is unit-testable without a document, mirroring `fate/snapshot.ts`.
 * A browser that refuses storage degrades to "unmarked" — the one-shot may show again,
 * but nothing breaks.
 */

export interface MarkerStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

const MARKER_VALUE = "1";

/** Keyed by user id so accounts on one browser never suppress each other. */
export function markerKey(name: string, schema: string, userId: string): string {
	return `${name}:${schema}:user:${userId}`;
}

export interface PerUserMarker {
	readonly key: (userId: string) => string;
	readonly isSet: (storage: MarkerStorage | null, userId: string | null) => boolean;
	/** Idempotent; a failed write stays silent — losing the marker only re-shows the one-shot. */
	readonly set: (storage: MarkerStorage | null, userId: string | null) => void;
}

export function perUserMarker(name: string, schema: string): PerUserMarker {
	const key = (userId: string) => markerKey(name, schema, userId);
	return {
		key,
		isSet: (storage, userId) =>
			!!storage && !!userId && storage.getItem(key(userId)) === MARKER_VALUE,
		set: (storage, userId) => {
			if (!storage || !userId) return;
			try {
				storage.setItem(key(userId), MARKER_VALUE);
			} catch {
				// Private mode / quota: degrade to "not marked", never break the arrival.
			}
		},
	};
}

/**
 * `null` when unavailable — Safari private mode throws on `window.localStorage` access,
 * and SSR/boot has no window at all (same defensive shape as `fate/snapshot.ts`).
 */
export function markerStorage(): MarkerStorage | null {
	if (typeof window === "undefined") return null;
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}
