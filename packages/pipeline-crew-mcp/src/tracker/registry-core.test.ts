/**
 * The soft-state registry semantics, tested in isolation from any transport: announce/lookup
 * round-trip, heartbeat-driven TTL aging, connection-is-lease role uniqueness + release, and the
 * explicit not-present result. These are the four acceptance criteria at the domain level.
 */
import {assert, describe, it} from "@effect/vitest";
import * as Core from "./registry-core.ts";

const T0 = 1_000_000; // an arbitrary epoch-millis baseline
const secs = (n: number) => n * 1000;

describe("registry-core — announce / lookup", () => {
	it("announce then lookup round-trips the peer for its role", () => {
		const {state} = Core.acquire(Core.empty(), {
			role: "builder",
			peer: "peer-a",
			ttlSeconds: 30,
			nowMillis: T0,
		});
		const found = Core.lookup(state, "builder", T0);
		assert.deepStrictEqual(found, [{peer: "peer-a", role: "builder", lastSeenMillis: T0}]);
	});

	it("a lookup of an absent role returns an explicit empty result (never a silent drop)", () => {
		assert.deepStrictEqual(Core.lookup(Core.empty(), "nobody", T0), []);
	});
});

describe("registry-core — heartbeat TTL aging", () => {
	it("a peer that stops heart-beating ages out of lookups past its TTL", () => {
		const {state} = Core.acquire(Core.empty(), {
			role: "builder",
			peer: "peer-a",
			ttlSeconds: 30,
			nowMillis: T0,
		});
		assert.lengthOf(Core.lookup(state, "builder", T0 + secs(29)), 1, "still live before TTL");
		assert.lengthOf(Core.lookup(state, "builder", T0 + secs(31)), 0, "aged out after TTL");
	});

	it("a heartbeat refreshes the window, keeping the peer discoverable", () => {
		const acquired = Core.acquire(Core.empty(), {
			role: "builder",
			peer: "peer-a",
			ttlSeconds: 30,
			nowMillis: T0,
		}).state;
		const beat = Core.heartbeat(acquired, {
			peer: "peer-a",
			ttlSeconds: 30,
			nowMillis: T0 + secs(20),
		});
		// Without the heartbeat this instant (T0+40s) would be expired; the beat at T0+20s carries it.
		assert.lengthOf(Core.lookup(beat, "builder", T0 + secs(40)), 1);
	});
});

describe("registry-core — connection-is-lease role uniqueness", () => {
	it("a second live acquire of a held role collides and does not steal the lease", () => {
		const held = Core.acquire(Core.empty(), {
			role: "builder",
			peer: "peer-a",
			ttlSeconds: 30,
			nowMillis: T0,
		}).state;
		const {state, outcome} = Core.acquire(held, {
			role: "builder",
			peer: "peer-b",
			ttlSeconds: 30,
			nowMillis: T0 + secs(1),
		});
		assert.deepStrictEqual(outcome, {_tag: "Collision", owner: "peer-a", sinceMillis: T0});
		assert.deepStrictEqual(Core.lookup(state, "builder", T0 + secs(1)), [
			{peer: "peer-a", role: "builder", lastSeenMillis: T0},
		]);
	});

	it("releasing the connection frees the lease for another peer", () => {
		const held = Core.acquire(Core.empty(), {
			role: "builder",
			peer: "peer-a",
			ttlSeconds: 30,
			nowMillis: T0,
		}).state;
		const freed = Core.release(held, "peer-a");
		assert.deepStrictEqual(Core.lookup(freed, "builder", T0), []);
		const {outcome} = Core.acquire(freed, {
			role: "builder",
			peer: "peer-b",
			ttlSeconds: 30,
			nowMillis: T0 + secs(1),
		});
		assert.deepStrictEqual(outcome, {_tag: "Granted", owner: "peer-b", sinceMillis: T0 + secs(1)});
	});

	it("an expired holder frees the lease — a later acquire is granted, not a collision", () => {
		const held = Core.acquire(Core.empty(), {
			role: "builder",
			peer: "peer-a",
			ttlSeconds: 30,
			nowMillis: T0,
		}).state;
		const {outcome} = Core.acquire(held, {
			role: "builder",
			peer: "peer-b",
			ttlSeconds: 30,
			nowMillis: T0 + secs(31),
		});
		assert.strictEqual(outcome._tag, "Granted");
	});

	it("a re-acquire by the same peer keeps its original `since`", () => {
		const held = Core.acquire(Core.empty(), {
			role: "builder",
			peer: "peer-a",
			ttlSeconds: 30,
			nowMillis: T0,
		}).state;
		const {outcome} = Core.acquire(held, {
			role: "builder",
			peer: "peer-a",
			ttlSeconds: 30,
			nowMillis: T0 + secs(5),
		});
		assert.deepStrictEqual(outcome, {_tag: "Granted", owner: "peer-a", sinceMillis: T0});
	});
});
