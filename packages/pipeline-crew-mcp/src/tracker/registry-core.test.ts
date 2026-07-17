/**
 * The soft-state registry semantics, tested in isolation from any transport: announce/lookup
 * round-trip, heartbeat-driven TTL aging, connection-is-lease role uniqueness + release, and the
 * explicit not-present result — plus the resource-claim lifecycle (ADR 0191): keyspace separation,
 * presence-derived claim liveness, steal-release protection, and presence-only heartbeat refresh.
 */
import {assert, describe, it} from "@effect/vitest";
import * as Core from "./registry-core.ts";

const T0 = 1_000_000; // an arbitrary epoch-millis baseline
const secs = (n: number) => n * 1000;

/** Give `peer` a live presence lease for `role` as of `at` — the claim-liveness clock. */
const withPresence = (
	state: Core.RegistryState,
	peer: string,
	role: string,
	at: number,
): Core.RegistryState => Core.acquire(state, {role, peer, ttlSeconds: 30, nowMillis: at}).state;

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

describe("registry-core — keyspace separation (ADR 0191 facet 1)", () => {
	it("a claim on a resource never surfaces as a role presence — the keyspaces are disjoint", () => {
		let state = withPresence(Core.empty(), "peer-a", "builder", T0);
		// claim resource "3210" whose id COLLIDES with what could be a role string
		state = Core.claimResource(state, {
			resource: "3210",
			holder: "peer-a",
			claimantRole: "builder",
			nowMillis: T0,
		}).state;
		// a role lookup of the same string reads the presence keyspace only ⇒ never the claim holder
		assert.deepStrictEqual(Core.lookup(state, "3210", T0), []);
		// while the claim keyspace does hold it
		assert.strictEqual(Core.claimHolder(state, "3210", T0), "peer-a");
	});

	it("a granted claim records the claimant's role without a schema change", () => {
		const {state} = Core.claimResource(withPresence(Core.empty(), "peer-a", "builder", T0), {
			resource: "issue-1",
			holder: "peer-a",
			claimantRole: "builder",
			nowMillis: T0,
		});
		assert.strictEqual(state.claims.get("issue-1")?.claimantRole, "builder");
	});
});

describe("registry-core — presence-derived claim liveness (ADR 0191 facet 2)", () => {
	it("a claim is live exactly while its holder's presence is live", () => {
		let state = withPresence(Core.empty(), "peer-a", "builder", T0);
		state = Core.claimResource(state, {
			resource: "issue-1",
			holder: "peer-a",
			claimantRole: "builder",
			nowMillis: T0,
		}).state;
		assert.strictEqual(
			Core.claimHolder(state, "issue-1", T0 + secs(29)),
			"peer-a",
			"live before TTL",
		);
		assert.isUndefined(
			Core.claimHolder(state, "issue-1", T0 + secs(31)),
			"stale once the holder's presence ages out — no independent claim timer",
		);
	});

	it("a second claim collides while the holder is present, and is granted once it ages out", () => {
		let state = withPresence(Core.empty(), "peer-a", "builder", T0);
		state = Core.claimResource(state, {
			resource: "issue-1",
			holder: "peer-a",
			claimantRole: "builder",
			nowMillis: T0,
		}).state;
		const collided = Core.claimResource(state, {
			resource: "issue-1",
			holder: "peer-b",
			claimantRole: "reviewer",
			nowMillis: T0 + secs(1),
		});
		assert.deepStrictEqual(collided.outcome, {
			_tag: "Collision",
			holder: "peer-a",
			sinceMillis: T0,
		});
		// once peer-a's presence has aged out, its claim is stale and the resource is free again
		const granted = Core.claimResource(state, {
			resource: "issue-1",
			holder: "peer-b",
			claimantRole: "reviewer",
			nowMillis: T0 + secs(31),
		});
		assert.strictEqual(granted.outcome._tag, "Granted");
	});

	it("a re-claim by the same holder keeps its original `since`", () => {
		let state = withPresence(Core.empty(), "peer-a", "builder", T0);
		state = Core.claimResource(state, {
			resource: "issue-1",
			holder: "peer-a",
			claimantRole: "builder",
			nowMillis: T0,
		}).state;
		const {outcome} = Core.claimResource(state, {
			resource: "issue-1",
			holder: "peer-a",
			claimantRole: "builder",
			nowMillis: T0 + secs(5),
		});
		assert.deepStrictEqual(outcome, {_tag: "Granted", holder: "peer-a", sinceMillis: T0});
	});
});

describe("registry-core — Release + reaping (ADR 0191 facets 2 + 3)", () => {
	it("releaseClaim frees only the caller's own claim — steal-release is a no-op", () => {
		let state = withPresence(Core.empty(), "peer-a", "builder", T0);
		state = Core.claimResource(state, {
			resource: "issue-1",
			holder: "peer-a",
			claimantRole: "builder",
			nowMillis: T0,
		}).state;
		const foreign = Core.releaseClaim(state, {resource: "issue-1", claimant: "peer-b"});
		assert.strictEqual(
			Core.claimHolder(foreign, "issue-1", T0),
			"peer-a",
			"a non-holder cannot free it",
		);
		const freed = Core.releaseClaim(state, {resource: "issue-1", claimant: "peer-a"});
		assert.isUndefined(Core.claimHolder(freed, "issue-1", T0), "the holder frees its own claim");
	});

	it("releasing a claim that does not exist is an idempotent no-op", () => {
		const state = withPresence(Core.empty(), "peer-a", "builder", T0);
		const after = Core.releaseClaim(state, {resource: "never-claimed", claimant: "peer-a"});
		assert.strictEqual(after, state);
	});

	it("release(peer) reaps every claim the peer held — its presence is gone with the connection", () => {
		let state = withPresence(Core.empty(), "peer-a", "builder", T0);
		state = Core.claimResource(state, {
			resource: "issue-1",
			holder: "peer-a",
			claimantRole: "builder",
			nowMillis: T0,
		}).state;
		const closed = Core.release(state, "peer-a");
		assert.strictEqual(
			closed.claims.size,
			0,
			"the closed peer's claims are reaped with its presence",
		);
		assert.strictEqual(closed.leases.size, 0);
	});

	it("prune reaps a claim whose holder has no live presence, and keeps a live one", () => {
		let state = withPresence(Core.empty(), "peer-a", "builder", T0);
		state = Core.claimResource(state, {
			resource: "issue-1",
			holder: "peer-a",
			claimantRole: "builder",
			nowMillis: T0,
		}).state;
		assert.strictEqual(
			Core.prune(state, T0 + secs(10)).claims.size,
			1,
			"kept while the holder is present",
		);
		assert.strictEqual(
			Core.prune(state, T0 + secs(31)).claims.size,
			0,
			"reaped once the holder ages out",
		);
	});
});

describe("registry-core — heartbeat refreshes presence only (ADR 0191 facet 4)", () => {
	it("a heartbeat carries the claim's liveness transitively via presence, never touching the claim record", () => {
		let state = withPresence(Core.empty(), "peer-a", "builder", T0);
		state = Core.claimResource(state, {
			resource: "issue-1",
			holder: "peer-a",
			claimantRole: "builder",
			nowMillis: T0,
		}).state;
		// beat at T0+20 refreshes the PRESENCE lease; the claim has no timer of its own to bump
		const beat = Core.heartbeat(state, {peer: "peer-a", ttlSeconds: 30, nowMillis: T0 + secs(20)});
		// without the heartbeat, presence (and thus the claim) would be stale at T0+40; the beat carries it
		assert.strictEqual(Core.claimHolder(beat, "issue-1", T0 + secs(40)), "peer-a");
		// the claim record itself is untouched — the heartbeat iterated the presence keyspace only
		assert.strictEqual(beat.claims.get("issue-1")?.claimedAtMillis, T0);
	});
});
