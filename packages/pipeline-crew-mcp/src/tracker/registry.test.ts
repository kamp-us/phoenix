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
const at = "2026-07-16T10:00:00Z";

describe("tracker registry — wire round-trips (RpcTest in-memory)", () => {
	it.effect("announce then lookup round-trips a peer's role + inbox address", () =>
		Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(TrackerRegistry);
			yield* client.AnnouncePresence({peer: "inbox://peer-a", role: "builder", at});
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

	it.effect("Claim grants a free role lease and collides on a second live acquire", () =>
		Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(TrackerRegistry);
			const first = yield* client.Claim({
				resource: "builder",
				claimant: "peer-a",
				role: "builder",
				at,
			});
			assert.isTrue(first.granted);
			assert.isFalse(first.collision);
			assert.strictEqual(first.owner, "peer-a");

			const second = yield* client.Claim({
				resource: "builder",
				claimant: "peer-b",
				role: "builder",
				at,
			});
			assert.isFalse(second.granted);
			assert.isTrue(second.collision);
			assert.strictEqual(second.owner, "peer-a", "the incumbent keeps the lease");
		}).pipe(Effect.scoped, Effect.provide(handlers)),
	);

	it.effect("a heartbeat is accepted for a live peer", () =>
		Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(TrackerRegistry);
			yield* client.AnnouncePresence({peer: "inbox://peer-a", role: "builder", at});
			yield* client.Heartbeat({peer: "inbox://peer-a", ttlSeconds: 60, at});
			const result = yield* client.LookupRole({role: "builder"});
			assert.lengthOf(result.peers, 1);
		}).pipe(Effect.scoped, Effect.provide(handlers)),
	);
});
