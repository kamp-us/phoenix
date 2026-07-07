/**
 * Feed-snapshot module contract (#2319, epic #2316). Two tiers of coverage:
 *
 *   1. The pure persistence layer (read/write/hydrate/save + throttle/installer) against
 *      a fake client + in-memory storage — round-trip fidelity and the four tolerance
 *      paths (corrupt, quota, oversized, scope/version mismatch), each degrading to a
 *      clean no-snapshot boot with no throw.
 *   2. A REAL `@nkzw/fate` client round-trip (the `optimisticCommentAdd.realstore`
 *      idiom): populate a client's store, dehydrate → persist → hydrate into a fresh
 *      client, and assert the fresh client re-dehydrates to an equal state — proving the
 *      persist layer carries fate's dehydrated cache (records + list/pagination state)
 *      without loss, and that fate rejects a scope-mismatched snapshot (which we catch).
 *
 * The "paints without a skeleton" experience is a flag-on behavior the verification
 * child (#2326) measures on a deployed stage — the unit tier proves the module contract
 * the epic's testing strategy scopes here.
 */
import {createClient, type FateDehydratedState} from "@nkzw/fate";
import {describe, expect, it, vi} from "vitest";
import {
	ANON_IDENTITY,
	authedIdentity,
	clearSnapshot,
	createLeadingThrottle,
	hydrateFromSnapshot,
	installSnapshotPersistence,
	type KeyValueStorage,
	type PersistenceBindings,
	readSnapshot,
	type SnapshotClient,
	saveSnapshot,
	snapshotKey,
	writeSnapshot,
} from "./snapshot";

/** In-memory `localStorage` stand-in; optionally throws on `setItem`/`getItem` to model
 *  quota-exceeded and access-denied (Safari private mode). */
function memoryStorage(
	opts: {throwOnSet?: boolean; throwOnGet?: boolean} = {},
): KeyValueStorage & {map: Map<string, string>} {
	const map = new Map<string, string>();
	return {
		map,
		getItem: (k) => {
			if (opts.throwOnGet) throw new Error("access denied");
			return map.get(k) ?? null;
		},
		setItem: (k, v) => {
			if (opts.throwOnSet) throw new DOMException("quota", "QuotaExceededError");
			map.set(k, v);
		},
		removeItem: (k) => {
			map.delete(k);
		},
	};
}

const KEY = snapshotKey("v1", ANON_IDENTITY);

/** A fake client returning a fixed dehydrated state and recording hydrate calls. */
function fakeClient(
	state: FateDehydratedState,
): SnapshotClient & {hydrated: FateDehydratedState[]} {
	const hydrated: FateDehydratedState[] = [];
	return {
		hydrated,
		dehydrate: () => state,
		hydrate: (s) => {
			hydrated.push(s);
		},
	};
}

const sampleState: FateDehydratedState = {
	// A representative payload carrying list/pagination + connection-identity shaped
	// fields (the `?sort`/`host` connection args live inside `data`) — the round-trip
	// must preserve them byte-for-byte.
	data: {
		rootLists: [["posts", ["Post:1", "Post:2"]]],
		lists: {
			"posts(sort:hot,host:example.com)": {ids: ["Post:1", "Post:2"], pagination: {hasNext: true}},
		},
	},
	scope: "schema-abc",
	version: 1,
};

describe("readSnapshot / writeSnapshot round-trip", () => {
	it("persists and reads back a structurally-valid snapshot unchanged", () => {
		const storage = memoryStorage();
		expect(writeSnapshot(storage, KEY, sampleState)).toBe(true);
		expect(readSnapshot(storage, KEY)).toEqual(sampleState);
	});

	it("preserves nested list + pagination + connection-identity fields through JSON", () => {
		const storage = memoryStorage();
		writeSnapshot(storage, KEY, sampleState);
		const restored = readSnapshot(storage, KEY);
		expect(restored?.data).toEqual(sampleState.data);
	});

	it("reads back null for an absent key", () => {
		expect(readSnapshot(memoryStorage(), KEY)).toBeNull();
	});
});

describe("readSnapshot tolerance — every bad state degrades to a clean no-snapshot boot", () => {
	it("returns null on a corrupt (non-JSON) payload, no throw", () => {
		const storage = memoryStorage();
		storage.map.set(KEY, "{not valid json");
		expect(() => readSnapshot(storage, KEY)).not.toThrow();
		expect(readSnapshot(storage, KEY)).toBeNull();
	});

	it("returns null on a structurally-wrong payload (wrong version / missing fields)", () => {
		const storage = memoryStorage();
		storage.map.set(KEY, JSON.stringify({data: {}, scope: "x", version: 2}));
		expect(readSnapshot(storage, KEY)).toBeNull();
		storage.map.set(KEY, JSON.stringify({nope: true}));
		expect(readSnapshot(storage, KEY)).toBeNull();
	});

	it("returns null on an oversized payload without parsing it", () => {
		const storage = memoryStorage();
		storage.map.set(KEY, JSON.stringify(sampleState));
		expect(readSnapshot(storage, KEY, 10)).toBeNull();
	});

	it("returns null (no throw) when getItem itself throws (access denied)", () => {
		const storage = memoryStorage({throwOnGet: true});
		expect(() => readSnapshot(storage, KEY)).not.toThrow();
		expect(readSnapshot(storage, KEY)).toBeNull();
	});
});

describe("writeSnapshot tolerance", () => {
	it("returns false (no throw) on a quota-exceeded setItem", () => {
		const storage = memoryStorage({throwOnSet: true});
		expect(() => writeSnapshot(storage, KEY, sampleState)).not.toThrow();
		expect(writeSnapshot(storage, KEY, sampleState)).toBe(false);
	});

	it("refuses to persist an oversized snapshot", () => {
		const storage = memoryStorage();
		expect(writeSnapshot(storage, KEY, sampleState, 10)).toBe(false);
		expect(storage.map.has(KEY)).toBe(false);
	});
});

describe("hydrateFromSnapshot", () => {
	it("hydrates the client from a persisted snapshot and reports true", () => {
		const storage = memoryStorage();
		writeSnapshot(storage, KEY, sampleState);
		const client = fakeClient(sampleState);
		expect(hydrateFromSnapshot(client, storage)).toBe(true);
		expect(client.hydrated).toEqual([sampleState]);
	});

	it("is a no-op returning false when there is no snapshot", () => {
		const client = fakeClient(sampleState);
		expect(hydrateFromSnapshot(client, memoryStorage())).toBe(false);
		expect(client.hydrated).toEqual([]);
	});

	it("swallows a client.hydrate throw (scope/version mismatch, pending requests) → false", () => {
		const storage = memoryStorage();
		writeSnapshot(storage, KEY, sampleState);
		const throwing: SnapshotClient = {
			dehydrate: () => sampleState,
			hydrate: () => {
				throw new Error("fate: Hydration state scope does not match this client.");
			},
		};
		expect(() => hydrateFromSnapshot(throwing, storage)).not.toThrow();
		expect(hydrateFromSnapshot(throwing, storage)).toBe(false);
	});
});

describe("saveSnapshot", () => {
	it("dehydrates and persists, reporting true", () => {
		const storage = memoryStorage();
		const client = fakeClient(sampleState);
		expect(saveSnapshot(client, storage)).toBe(true);
		expect(readSnapshot(storage, KEY)).toEqual(sampleState);
	});

	it("swallows a client.dehydrate throw (requests in flight) → false, nothing written", () => {
		const storage = memoryStorage();
		const throwing: SnapshotClient = {
			dehydrate: () => {
				throw new Error("fate: Cannot dehydrate while requests are pending.");
			},
			hydrate: () => undefined,
		};
		expect(() => saveSnapshot(throwing, storage)).not.toThrow();
		expect(saveSnapshot(throwing, storage)).toBe(false);
		expect(storage.map.size).toBe(0);
	});
});

describe("createLeadingThrottle", () => {
	it("allows the first call and blocks until the window elapses", () => {
		let t = 1000;
		const allow = createLeadingThrottle(2000, () => t);
		expect(allow()).toBe(true); // leading edge
		t = 1500;
		expect(allow()).toBe(false); // within window
		t = 3000;
		expect(allow()).toBe(true); // window elapsed
	});
});

describe("installSnapshotPersistence — event-driven, throttled, not per-render", () => {
	function fakeBindings(): PersistenceBindings & {
		fire: (type: string) => void;
		hidden: boolean;
		listeners: Map<string, Set<() => void>>;
	} {
		const listeners = new Map<string, Set<() => void>>();
		return {
			listeners,
			hidden: false,
			addEventListener(type, handler) {
				(listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(handler);
			},
			removeEventListener(type, handler) {
				listeners.get(type)?.delete(handler);
			},
			isHidden() {
				return this.hidden;
			},
			fire(type) {
				for (const h of listeners.get(type) ?? []) h();
			},
		};
	}

	it("persists on pagehide", () => {
		const storage = memoryStorage();
		const client = fakeClient(sampleState);
		const bindings = fakeBindings();
		installSnapshotPersistence(client, storage, bindings, {now: () => 0});
		bindings.fire("pagehide");
		expect(readSnapshot(storage, KEY)).toEqual(sampleState);
	});

	it("persists on visibilitychange only when hidden", () => {
		const storage = memoryStorage();
		const client = fakeClient(sampleState);
		const bindings = fakeBindings();
		installSnapshotPersistence(client, storage, bindings, {now: () => 0});
		bindings.hidden = false;
		bindings.fire("visibilitychange");
		expect(storage.map.size).toBe(0); // visible → no write
		bindings.hidden = true;
		bindings.fire("visibilitychange");
		expect(readSnapshot(storage, KEY)).toEqual(sampleState);
	});

	it("throttles back-to-back events into a single write", () => {
		const storage = memoryStorage();
		const save = vi.fn(() => sampleState);
		const client: SnapshotClient = {dehydrate: save, hydrate: () => undefined};
		const bindings = fakeBindings();
		bindings.hidden = true;
		let t = 0;
		installSnapshotPersistence(client, storage, bindings, {now: () => t, throttleMs: 2000});
		bindings.fire("visibilitychange"); // t=0 → save
		bindings.fire("pagehide"); // t=0, within window → throttled
		expect(save).toHaveBeenCalledTimes(1);
		t = 3000;
		bindings.fire("pagehide"); // window elapsed → save again
		expect(save).toHaveBeenCalledTimes(2);
	});

	it("uninstall removes both listeners", () => {
		const storage = memoryStorage();
		const client = fakeClient(sampleState);
		const bindings = fakeBindings();
		const uninstall = installSnapshotPersistence(client, storage, bindings, {now: () => 0});
		uninstall();
		bindings.fire("pagehide");
		bindings.fire("visibilitychange");
		expect(storage.map.size).toBe(0);
	});
});

/**
 * Real `@nkzw/fate` client round-trip — the `optimisticCommentAdd.realstore` idiom: a
 * minimal client with a never-invoked transport, driven through the REAL dehydrate /
 * hydrate the persistence layer wraps.
 */
function realClient(hydrationScope = "test-scope") {
	return createClient({
		hydrationScope,
		roots: {},
		types: [{type: "Post"}],
		transport: {
			fetchById: () => {
				throw new Error("transport unused");
			},
			fetchList: () => {
				throw new Error("transport unused");
			},
			fetchQuery: () => {
				throw new Error("transport unused");
			},
			mutate: () => {
				throw new Error("transport unused");
			},
		},
	});
}

describe("real fate client round-trip", () => {
	it("carries the dehydrated cache through persist → hydrate without loss", () => {
		const source = realClient();
		source.write("Post", {id: "1", title: "merhaba"}, new Set(["id", "title"]));
		source.write("Post", {id: "2", title: "dünya"}, new Set(["id", "title"]));

		const storage = memoryStorage();
		expect(saveSnapshot(source, storage)).toBe(true);

		const restored = realClient();
		expect(hydrateFromSnapshot(restored, storage)).toBe(true);

		// A fresh client that re-dehydrates to the same state proves the persist layer
		// lost nothing fate had encoded (records, lists, coverage, root lists).
		expect(restored.dehydrate()).toEqual(source.dehydrate());
	});

	it("rejects a scope-mismatched snapshot (fate throws; we catch) → clean no-snapshot boot", () => {
		const source = realClient("scope-A");
		source.write("Post", {id: "1", title: "x"}, new Set(["id", "title"]));
		const storage = memoryStorage();
		saveSnapshot(source, storage);

		const restored = realClient("scope-B"); // schema rotated
		expect(() => hydrateFromSnapshot(restored, storage)).not.toThrow();
		expect(hydrateFromSnapshot(restored, storage)).toBe(false);
	});
});

/**
 * The identity-keyed authed tier (#2321): the authed snapshot embeds the viewer's private
 * `myVote`/`isSaved` overlay, so its storage key must be scoped per user id — a snapshot
 * written under user A must NEVER hydrate under user B or under anon (both directions), and
 * an identity's snapshot must be torn down when its session ends (sign-out / identity switch
 * / account deletion). These pin the pure key-scoping + teardown contract the browser-bound
 * `hydrateAuthedClient` / `installAuthedSnapshotPersistence` / `teardownAuthedSnapshot`
 * wrappers (flag-gated, `window`-bound — untested here, as the anon siblings are) delegate to.
 */
describe("authedIdentity — per-user key scoping, disjoint from anon", () => {
	it("namespaces the identity under `user:` so it cannot collide with anon or another id", () => {
		expect(authedIdentity("42")).toBe("user:42");
		expect(authedIdentity("42")).not.toBe(ANON_IDENTITY);
		expect(authedIdentity("A")).not.toBe(authedIdentity("B"));
		// Even a user whose id were literally "anon" keys to a distinct segment.
		expect(authedIdentity(ANON_IDENTITY)).not.toBe(ANON_IDENTITY);
	});
});

describe("authed snapshot — cross-identity hydration is rejected (both directions, #2321 AC2)", () => {
	it("a snapshot written under user A does NOT hydrate under user B", () => {
		const storage = memoryStorage();
		// A's snapshot carries A's private overlay.
		saveSnapshot(fakeClient(sampleState), storage, {identity: authedIdentity("A")});

		const asB = fakeClient(sampleState);
		expect(hydrateFromSnapshot(asB, storage, {identity: authedIdentity("B")})).toBe(false);
		expect(asB.hydrated).toEqual([]); // B's client never saw A's overlay
	});

	it("a snapshot written under user A does NOT hydrate under anon", () => {
		const storage = memoryStorage();
		saveSnapshot(fakeClient(sampleState), storage, {identity: authedIdentity("A")});

		const asAnon = fakeClient(sampleState);
		expect(hydrateFromSnapshot(asAnon, storage, {identity: ANON_IDENTITY})).toBe(false);
		expect(asAnon.hydrated).toEqual([]);
	});

	it("the inverse: an anon snapshot does NOT hydrate under an authed identity", () => {
		const storage = memoryStorage();
		saveSnapshot(fakeClient(sampleState), storage, {identity: ANON_IDENTITY});

		const asA = fakeClient(sampleState);
		expect(hydrateFromSnapshot(asA, storage, {identity: authedIdentity("A")})).toBe(false);
		expect(asA.hydrated).toEqual([]);
	});

	it("the same identity DOES hydrate its own snapshot (positive control)", () => {
		const storage = memoryStorage();
		saveSnapshot(fakeClient(sampleState), storage, {identity: authedIdentity("A")});

		const asA = fakeClient(sampleState);
		expect(hydrateFromSnapshot(asA, storage, {identity: authedIdentity("A")})).toBe(true);
		expect(asA.hydrated).toEqual([sampleState]);
	});

	it("restores the deep-linked subfeed (?sort/host connection state) for the authed tier (AC5)", () => {
		// `sampleState.data` carries the `posts(sort:hot,host:example.com)` list identity — the
		// `?sort=…` / `/pano/site/:host` subfeed. Through the authed key it round-trips intact,
		// so a deep-linked subfeed restores instantly for a signed-in viewer too.
		const storage = memoryStorage();
		saveSnapshot(fakeClient(sampleState), storage, {identity: authedIdentity("A")});
		const restored = readSnapshot(storage, snapshotKey("v1", authedIdentity("A")));
		expect(restored?.data).toEqual(sampleState.data);
	});
});

describe("authed snapshot teardown — the sign-out / identity-change / deletion seam (#2321 AC3)", () => {
	it("clearSnapshot removes exactly the target identity's snapshot, leaving siblings intact", () => {
		const storage = memoryStorage();
		saveSnapshot(fakeClient(sampleState), storage, {identity: authedIdentity("A")});
		saveSnapshot(fakeClient(sampleState), storage, {identity: authedIdentity("B")});
		saveSnapshot(fakeClient(sampleState), storage, {identity: ANON_IDENTITY});

		// Tear down A (sign-out / switch away from A / A's account deletion).
		clearSnapshot(storage, {identity: authedIdentity("A")});

		// A is gone; B and anon survive — teardown is strictly identity-scoped.
		expect(readSnapshot(storage, snapshotKey("v1", authedIdentity("A")))).toBeNull();
		expect(readSnapshot(storage, snapshotKey("v1", authedIdentity("B")))).not.toBeNull();
		expect(readSnapshot(storage, snapshotKey("v1", ANON_IDENTITY))).not.toBeNull();
	});

	it("after teardown, A's own re-hydration finds nothing (the overlay does not survive its session)", () => {
		const storage = memoryStorage();
		saveSnapshot(fakeClient(sampleState), storage, {identity: authedIdentity("A")});
		clearSnapshot(storage, {identity: authedIdentity("A")});

		const asA = fakeClient(sampleState);
		expect(hydrateFromSnapshot(asA, storage, {identity: authedIdentity("A")})).toBe(false);
		expect(asA.hydrated).toEqual([]);
	});

	it("tolerates a throwing removeItem (Safari private mode) → clean no-op", () => {
		const storage: KeyValueStorage = {
			getItem: () => null,
			setItem: () => undefined,
			removeItem: () => {
				throw new Error("access denied");
			},
		};
		expect(() => clearSnapshot(storage, {identity: authedIdentity("A")})).not.toThrow();
	});
});
