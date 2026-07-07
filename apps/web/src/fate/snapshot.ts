/**
 * Feed snapshot — leg A of the "instant /pano reload" epic (#2316, child #2319).
 *
 * Persist the public (always-anonymous) fate cache to `localStorage` and restore it
 * at boot, so a reload paints the last-seen feed synchronously — before the network
 * revalidate lands — instead of a skeleton. Terms: a *feed snapshot* is the persisted,
 * versioned dehydrated fate cache; the *base feed* it carries is viewer-invariant
 * (leg B); the *viewer overlay* (`myVote`/`isSaved`) is composed on top after the
 * session resolves (the authed tier, #2321 — out of scope here).
 *
 * Uses fate's native `FateClient.dehydrate()`/`hydrate()` (versioned, JSON-safe
 * `FateDehydratedState` with a schema-derived `hydrationScope`) — never a hand-rolled
 * serializer. `localStorage`, not IndexedDB, on purpose: the restore must be
 * synchronous so `hydrate()` runs *before* the first `useRequest` (fate's documented
 * hydrate-before-render contract; `hydrate()` also throws if the client already has
 * requests pending). Every failure mode — quota, corrupt/oversized payload,
 * scope/version mismatch, a client with in-flight requests — degrades to a clean
 * no-snapshot boot: a feed snapshot is a best-effort content cache, never load-bearing.
 *
 * Containment: the whole feature is dark behind `VITE_FEED_SNAPSHOT` (default-off);
 * #2326 flips it on measured evidence. A build-time env flag, NOT the server-evaluated
 * Flagship flag, because boot hydration must resolve synchronously before any async
 * `/api/flags/evaluate` round-trip could return — the `VITE_SENTRY_DSN` precedent
 * (`vite-env.d.ts`). Flag off ⇒ no storage reads or writes, byte-identical to today.
 */
import type {FateDehydratedState, HydrateOptions} from "react-fate";

/** Build-time containment flag (default-off). See the module docblock for why it is a
 *  Vite env var rather than the Flagship server flag. */
export const FEED_SNAPSHOT_ENABLED = import.meta.env.VITE_FEED_SNAPSHOT === "on";

/** Storage-key schema segment. fate's payload-embedded `scope` guards the fate schema
 *  itself (an incompatible dehydrated shape is rejected by `hydrate()`); this segment
 *  guards *our* keying/format — bump it to force-invalidate every persisted snapshot on
 *  an incompatible change to this module. */
export const FEED_SNAPSHOT_SCHEMA = "v1";

/** Identity segment for the always-anonymous public tier. The authed tier (#2321) keys
 *  per user-id and tears the snapshot down on identity change / sign-out. */
export const ANON_IDENTITY = "anon";

/** Cap a persisted snapshot's serialized length. An oversized payload is neither
 *  written nor read back (dropped to a clean boot), bounding both `localStorage`
 *  pressure and the synchronous boot-time parse cost. */
export const DEFAULT_MAX_SNAPSHOT_CHARS = 2_000_000;

/** Minimum gap between two persists. The save is event-driven (`pagehide` /
 *  `visibilitychange`), and both can fire back-to-back on the same tab-hide — the
 *  throttle collapses that into one write. */
export const DEFAULT_SAVE_THROTTLE_MS = 2_000;

/** The one storage-key shape: `fate-snapshot:<schema>:<identity>`. */
export function snapshotKey(schema: string, identity: string): string {
	return `fate-snapshot:${schema}:${identity}`;
}

/** The slice of a fate client this module drives — just the two persistence primitives,
 *  so the pure functions are testable with a fake and decoupled from the generated
 *  client type. */
export interface SnapshotClient {
	dehydrate(): FateDehydratedState;
	hydrate(state: FateDehydratedState, options?: HydrateOptions): void;
}

/** The `localStorage`-shaped subset this module needs, injected so the pure functions
 *  run without a DOM. */
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

/** A structurally-valid dehydrated snapshot is `{data, scope: string, version: 1}`.
 *  Anything else read from storage is treated as absent — fate's own `hydrate()` would
 *  reject it, but we screen here so a malformed blob never reaches the client. */
function isDehydratedState(value: unknown): value is FateDehydratedState {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as {version?: unknown; scope?: unknown};
	return candidate.version === 1 && typeof candidate.scope === "string" && "data" in candidate;
}

/** Read + parse a persisted snapshot, tolerating every failure to `null` (no throw):
 *  a `getItem` that throws, an absent key, an oversized blob, invalid JSON, or a
 *  structurally-wrong payload all degrade to "no snapshot". */
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

/** Serialize + persist a snapshot, tolerating every failure to `false` (no throw): a
 *  non-serializable state, an oversized payload (not written), or a quota-exceeded
 *  `setItem`. Returns whether the write landed. */
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

/** Restore a snapshot into the client. `hydrate()` throws on a version/scope mismatch,
 *  a payload that fails fate's decode limits, or a client with pending requests — all
 *  caught here so a bad snapshot degrades to a clean no-snapshot boot. Returns whether
 *  a snapshot was applied. */
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

/** Dehydrate the client and persist the snapshot. `dehydrate()` throws while a request
 *  or optimistic update is in flight (fate's contract) — caught here so a save is
 *  always best-effort. Returns whether the write landed. */
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

/** A leading-edge throttle gate: returns `true` at most once per `throttleMs`. Time is
 *  injected so the throttle is deterministically testable. */
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

/** The DOM bindings the persistence installer needs, injected so it is testable without
 *  a real `window`/`document`. */
export interface PersistenceBindings {
	addEventListener(type: string, handler: () => void): void;
	removeEventListener(type: string, handler: () => void): void;
	/** Whether the document is currently hidden (`visibilityState === "hidden"`). */
	isHidden(): boolean;
}

interface InstallOptions extends SnapshotScope {
	throttleMs?: number;
	now?: () => number;
}

/** Wire throttled snapshot persistence to `pagehide` and `visibilitychange` (on hide) —
 *  never per-render — and return an uninstaller. These two events fire as the tab is
 *  backgrounded or torn down, the last moment the cache is worth capturing. */
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

/** `localStorage`, or `null` if it is unavailable (Safari private mode throws on access,
 *  SSR/tests without a DOM have no `window`). A `null` storage disables persistence
 *  cleanly. */
export function browserSnapshotStorage(): KeyValueStorage | null {
	try {
		return typeof window === "undefined" ? null : window.localStorage;
	} catch {
		return null;
	}
}

/** Bind persistence to the real DOM: `pagehide` on `window`, `visibilitychange` on
 *  `document`. */
export function browserPersistenceBindings(): PersistenceBindings {
	const targetFor = (type: string): EventTarget =>
		type === "visibilitychange" ? document : window;
	return {
		addEventListener: (type, handler) => targetFor(type).addEventListener(type, handler),
		removeEventListener: (type, handler) => targetFor(type).removeEventListener(type, handler),
		isHidden: () => document.visibilityState === "hidden",
	};
}

/** Boot-time hydrate for the always-anonymous public client. No-op when the flag is off
 *  or `localStorage` is unavailable, so the flag-off path performs no storage reads. */
export function hydrateAnonPublicClient(client: SnapshotClient): void {
	if (!FEED_SNAPSHOT_ENABLED) return;
	const storage = browserSnapshotStorage();
	if (storage == null) return;
	hydrateFromSnapshot(client, storage, {identity: ANON_IDENTITY});
}

/** Install anon persistence for the public client's lifetime. No-op (an inert
 *  uninstaller) when the flag is off or `localStorage` is unavailable, so the flag-off
 *  path performs no storage writes. */
export function installAnonSnapshotPersistence(client: SnapshotClient): () => void {
	if (!FEED_SNAPSHOT_ENABLED) return () => {};
	const storage = browserSnapshotStorage();
	if (storage == null) return () => {};
	return installSnapshotPersistence(client, storage, browserPersistenceBindings(), {
		identity: ANON_IDENTITY,
	});
}
