/**
 * The registry over the real RPC machinery, in-memory: `RpcTest.makeClient` drives the
 * `TrackerRegistry` handlers (backed by `RegistryLive`) through the same client/server path a
 * socket transport would, without opening a socket. Proves announce/lookup round-trips, the
 * `Claim` lease acquire's granted/collision reply, and the explicit not-present lookup — all end
 * to end through decode/encode.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer} from "effect";
import {RpcTest} from "effect/unstable/rpc";
import {TrackerRegistry} from "./group.ts";
import {TrackerHandlers} from "./handlers.ts";
import {RegistryLive} from "./registry.ts";

const handlers = TrackerHandlers.pipe(Layer.provide(RegistryLive));

describe("tracker registry — wire round-trips (RpcTest in-memory)", () => {
	it.effect("announce then lookup round-trips a peer's role + inbox address", () =>
		Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(TrackerRegistry);
			yield* client.AnnouncePresence({peer: "inbox://peer-a", role: "builder"});
			const result = yield* client.LookupRole({role: "builder"});
			assert.strictEqual(result.role, "builder");
			assert.lengthOf(result.peers, 1);
			assert.strictEqual(result.peers[0]?.peer, "inbox://peer-a");
			assert.strictEqual(result.peers[0]?.role, "builder");
		}).pipe(Effect.scoped, Effect.provide(handlers)),
	);

	it.effect("a lookup of an absent role returns an explicit empty result", () =>
		Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(TrackerRegistry);
			const result = yield* client.LookupRole({role: "nobody"});
			assert.deepStrictEqual(result, {role: "nobody", peers: []});
		}).pipe(Effect.scoped, Effect.provide(handlers)),
	);

	it.effect("two peers announcing one role both surface — the engine pool is not collapsed", () =>
		Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(TrackerRegistry);
			// two engine instances of the same role, distinct per-instance inbox addresses
			yield* client.AnnouncePresence({peer: "inbox://em/one", role: "em"});
			yield* client.AnnouncePresence({peer: "inbox://em/two", role: "em"});
			const result = yield* client.LookupRole({role: "em"});
			assert.lengthOf(result.peers, 2, "the second announce did not overwrite the first");
			assert.deepStrictEqual(result.peers.map((p) => p.peer).sort(), [
				"inbox://em/one",
				"inbox://em/two",
			]);
		}).pipe(Effect.scoped, Effect.provide(handlers)),
	);

	it.effect("Claim grants a free resource and collides on a second acquire (holder present)", () =>
		Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(TrackerRegistry);
			// The incumbent's claim is live only while its presence is — announce it first (ADR 0191).
			yield* client.AnnouncePresence({peer: "peer-a", role: "builder"});
			const first = yield* client.Claim({
				resource: "issue-3054",
				claimant: "peer-a",
				role: "builder",
			});
			assert.isTrue(first.granted);
			assert.isFalse(first.collision);
			assert.strictEqual(first.owner, "peer-a");

			const second = yield* client.Claim({
				resource: "issue-3054",
				claimant: "peer-b",
				role: "builder",
			});
			assert.isFalse(second.granted);
			assert.isTrue(second.collision);
			assert.strictEqual(second.owner, "peer-a", "the incumbent keeps the claim");
		}).pipe(Effect.scoped, Effect.provide(handlers)),
	);

	it.effect("Release frees a held claim so another peer can then claim the resource", () =>
		Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(TrackerRegistry);
			yield* client.AnnouncePresence({peer: "peer-a", role: "builder"});
			yield* client.AnnouncePresence({peer: "peer-b", role: "reviewer"});
			yield* client.Claim({resource: "issue-3054", claimant: "peer-a", role: "builder"});
			yield* client.Release({resource: "issue-3054", claimant: "peer-a"});
			const reclaim = yield* client.Claim({
				resource: "issue-3054",
				claimant: "peer-b",
				role: "reviewer",
			});
			assert.isTrue(reclaim.granted, "the released resource is free for a new claimant");
			assert.strictEqual(reclaim.owner, "peer-b");
		}).pipe(Effect.scoped, Effect.provide(handlers)),
	);

	it.effect("Release by a non-holder is a no-op — a peer cannot steal-release (ADR 0191)", () =>
		Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(TrackerRegistry);
			yield* client.AnnouncePresence({peer: "peer-a", role: "builder"});
			yield* client.Claim({resource: "issue-3054", claimant: "peer-a", role: "builder"});
			// peer-b does not hold the claim: its release must not free peer-a's hold.
			yield* client.Release({resource: "issue-3054", claimant: "peer-b"});
			const stillHeld = yield* client.Claim({
				resource: "issue-3054",
				claimant: "peer-c",
				role: "builder",
			});
			assert.isTrue(stillHeld.collision, "peer-a still holds it — the foreign release was ignored");
			assert.strictEqual(stillHeld.owner, "peer-a");
		}).pipe(Effect.scoped, Effect.provide(handlers)),
	);

	it.effect(
		"LookupClaim returns the live holder of a claimed resource (the claim-aware routing read, #3886)",
		() =>
			Effect.gen(function* () {
				const client = yield* RpcTest.makeClient(TrackerRegistry);
				yield* client.AnnouncePresence({peer: "inbox://em-owner", role: "em"});
				yield* client.Claim({resource: "issue-3886", claimant: "inbox://em-owner", role: "em"});
				const held = yield* client.LookupClaim({resource: "issue-3886"});
				assert.deepStrictEqual(held, {resource: "issue-3886", holder: "inbox://em-owner"});
			}).pipe(Effect.scoped, Effect.provide(handlers)),
	);

	it.effect(
		"LookupClaim omits the holder for an unclaimed resource (an absent key, never a sentinel)",
		() =>
			Effect.gen(function* () {
				const client = yield* RpcTest.makeClient(TrackerRegistry);
				const unclaimed = yield* client.LookupClaim({resource: "issue-9999"});
				assert.deepStrictEqual(unclaimed, {resource: "issue-9999"});
			}).pipe(Effect.scoped, Effect.provide(handlers)),
	);

	it.effect("LookupClaim omits the holder once a released claim frees the resource", () =>
		Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(TrackerRegistry);
			yield* client.AnnouncePresence({peer: "inbox://em-owner", role: "em"});
			yield* client.Claim({resource: "issue-3886", claimant: "inbox://em-owner", role: "em"});
			yield* client.Release({resource: "issue-3886", claimant: "inbox://em-owner"});
			const freed = yield* client.LookupClaim({resource: "issue-3886"});
			assert.deepStrictEqual(freed, {resource: "issue-3886"}, "the freed resource has no holder");
		}).pipe(Effect.scoped, Effect.provide(handlers)),
	);

	it.effect("a heartbeat is accepted for a live peer", () =>
		Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(TrackerRegistry);
			yield* client.AnnouncePresence({peer: "inbox://peer-a", role: "builder"});
			yield* client.Heartbeat({peer: "inbox://peer-a", ttlSeconds: 60});
			const result = yield* client.LookupRole({role: "builder"});
			assert.lengthOf(result.peers, 1);
		}).pipe(Effect.scoped, Effect.provide(handlers)),
	);
});
