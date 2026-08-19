/**
 * Persist the fate cache to `localStorage` and restore it at boot, so a reload paints
 * the last-seen feed instead of a skeleton. See `.patterns/fate-hydration.md`.
 *
 * The flag is a build-time Vite env var, NOT the server-evaluated Flagship flag,
 * because boot hydration resolves synchronously — before any `/api/flags/evaluate`
 * round-trip could return.
 */
import type {FateDehydratedState, HydrateOptions} from "react-fate";

export const FEED_SNAPSHOT_ENABLED = import.meta.env.VITE_FEED_SNAPSHOT === "on";

/** Guards *our* keying/format (fate's payload-embedded `scope` guards the schema):
 *  bump it to force-invalidate every persisted snapshot. */
export const FEED_SNAPSHOT_SCHEMA = "v1";

export const ANON_IDENTITY = "anon";

/** Keying per user id is the guard that A's private `myVote`/`isSaved` overlay can
 *  never hydrate under B or under anon — a mismatched key simply finds no snapshot. */
export function authedIdentity(userId: string): string {
	return `user:${userId}`;
}

export const DEFAULT_MAX_SNAPSHOT_CHARS = 2_000_000;

/** `pagehide` and `visibilitychange` both fire on the same tab-hide — the throttle
 *  collapses that into one write. */
export const DEFAULT_SAVE_THROTTLE_MS = 2_000;

export function snapshotKey(schema: string, identity: string): string {
	return `fate-snapshot:${schema}:${identity}`;
}

export interface SnapshotClient {
	dehydrate(): FateDehydratedState;
	hydrate(state: FateDehydratedState, options?: HydrateOptions): void;
}

export interface KeyValueStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

interface SnapshotScope {
	schema?: string;
	identity?: string;
	maxChars?: number;
}

function isDehydratedState(value: unknown): value is FateDehydratedState {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as {version?: unknown; scope?: unknown};
	return candidate.version === 1 && typeof candidate.scope === "string" && "data" in candidate;
}

export function readSnapshot(
	storage: KeyValueStorage,
	key: string,
	maxChars: number = DEFAULT_MAX_SNAPSHOT_CHARS,
): FateDehydratedState | null {
	let raw: string | null;
	try {
		raw = storage.getItem(key);
	} catch {
		return null;
	}
	if (raw == null || raw.length > maxChars) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		return isDehydratedState(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

export function writeSnapshot(
	storage: KeyValueStorage,
	key: string,
	state: FateDehydratedState,
	maxChars: number = DEFAULT_MAX_SNAPSHOT_CHARS,
): boolean {
	let serialized: string;
	try {
		serialized = JSON.stringify(state);
	} catch {
		return false;
	}
	if (serialized.length > maxChars) return false;
	try {
		storage.setItem(key, serialized);
		return true;
	} catch {
		return false;
	}
}

/** `hydrate()` throws on a version/scope mismatch, a decode-limit overflow, or a client
 *  with pending requests; caught so a bad snapshot boots cold. `.patterns/fate-hydration.md` */
export function hydrateFromSnapshot(
	client: SnapshotClient,
	storage: KeyValueStorage,
	{
		schema = FEED_SNAPSHOT_SCHEMA,
		identity = ANON_IDENTITY,
		maxChars = DEFAULT_MAX_SNAPSHOT_CHARS,
	}: SnapshotScope = {},
): boolean {
	const state = readSnapshot(storage, snapshotKey(schema, identity), maxChars);
	if (state == null) return false;
	try {
		client.hydrate(state, {merge: "preserve-existing"});
		return true;
	} catch {
		return false;
	}
}

/** `dehydrate()` throws while a request or optimistic update is in flight, so a save is
 *  best-effort. `.patterns/fate-hydration.md` */
export function saveSnapshot(
	client: SnapshotClient,
	storage: KeyValueStorage,
	{
		schema = FEED_SNAPSHOT_SCHEMA,
		identity = ANON_IDENTITY,
		maxChars = DEFAULT_MAX_SNAPSHOT_CHARS,
	}: SnapshotScope = {},
): boolean {
	let state: FateDehydratedState;
	try {
		state = client.dehydrate();
	} catch {
		return false;
	}
	return writeSnapshot(storage, snapshotKey(schema, identity), state, maxChars);
}

/** `removeItem` throws in Safari private mode. */
export function clearSnapshot(
	storage: KeyValueStorage,
	{schema = FEED_SNAPSHOT_SCHEMA, identity = ANON_IDENTITY}: SnapshotScope = {},
): void {
	try {
		storage.removeItem(snapshotKey(schema, identity));
	} catch {
		// storage unreachable ⇒ nothing to clean up
	}
}

export function createLeadingThrottle(
	throttleMs: number,
	now: () => number = Date.now,
): () => boolean {
	let last = Number.NEGATIVE_INFINITY;
	return () => {
		const t = now();
		if (t - last < throttleMs) return false;
		last = t;
		return true;
	};
}

export interface PersistenceBindings {
	addEventListener(type: string, handler: () => void): void;
	removeEventListener(type: string, handler: () => void): void;
	isHidden(): boolean;
}

interface InstallOptions extends SnapshotScope {
	throttleMs?: number;
	now?: () => number;
}

export function installSnapshotPersistence(
	client: SnapshotClient,
	storage: KeyValueStorage,
	bindings: PersistenceBindings,
	{schema, identity, maxChars, throttleMs = DEFAULT_SAVE_THROTTLE_MS, now}: InstallOptions = {},
): () => void {
	const allow = createLeadingThrottle(throttleMs, now);
	const persist = () => {
		if (allow()) saveSnapshot(client, storage, {schema, identity, maxChars});
	};
	const onPageHide = () => persist();
	const onVisibility = () => {
		if (bindings.isHidden()) persist();
	};
	bindings.addEventListener("pagehide", onPageHide);
	bindings.addEventListener("visibilitychange", onVisibility);
	return () => {
		bindings.removeEventListener("pagehide", onPageHide);
		bindings.removeEventListener("visibilitychange", onVisibility);
	};
}

/** `null` when unavailable — Safari private mode throws on `window.localStorage` access. */
export function browserSnapshotStorage(): KeyValueStorage | null {
	try {
		return typeof window === "undefined" ? null : window.localStorage;
	} catch {
		return null;
	}
}

export function browserPersistenceBindings(): PersistenceBindings {
	const targetFor = (type: string): EventTarget =>
		type === "visibilitychange" ? document : window;
	return {
		addEventListener: (type, handler) => targetFor(type).addEventListener(type, handler),
		removeEventListener: (type, handler) => targetFor(type).removeEventListener(type, handler),
		isHidden: () => document.visibilityState === "hidden",
	};
}

export function hydrateAnonPublicClient(client: SnapshotClient): boolean {
	if (!FEED_SNAPSHOT_ENABLED) return false;
	const storage = browserSnapshotStorage();
	if (storage == null) return false;
	return hydrateFromSnapshot(client, storage, {identity: ANON_IDENTITY});
}

export function installAnonSnapshotPersistence(client: SnapshotClient): () => void {
	if (!FEED_SNAPSHOT_ENABLED) return () => {};
	const storage = browserSnapshotStorage();
	if (storage == null) return () => {};
	return installSnapshotPersistence(client, storage, browserPersistenceBindings(), {
		identity: ANON_IDENTITY,
	});
}

/** Must run at client creation in `FateProvider` AFTER the session resolves — before the
 *  first `useRequest`, and only once the `userId` this snapshot is keyed on is known. */
export function hydrateAuthedClient(client: SnapshotClient, userId: string): boolean {
	if (!FEED_SNAPSHOT_ENABLED) return false;
	const storage = browserSnapshotStorage();
	if (storage == null) return false;
	return hydrateFromSnapshot(client, storage, {identity: authedIdentity(userId)});
}

export function installAuthedSnapshotPersistence(
	client: SnapshotClient,
	userId: string,
): () => void {
	if (!FEED_SNAPSHOT_ENABLED) return () => {};
	const storage = browserSnapshotStorage();
	if (storage == null) return () => {};
	return installSnapshotPersistence(client, storage, browserPersistenceBindings(), {
		identity: authedIdentity(userId),
	});
}

/** Must stay wired at sign-out, identity change, and account deletion so a viewer's
 *  private feed overlay never outlives its session. */
export function teardownAuthedSnapshot(userId: string): void {
	if (!FEED_SNAPSHOT_ENABLED) return;
	const storage = browserSnapshotStorage();
	if (storage == null) return;
	clearSnapshot(storage, {identity: authedIdentity(userId)});
}
