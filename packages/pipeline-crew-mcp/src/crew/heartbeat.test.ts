/**
 * crew/heartbeat — the presence keepalive keeps a live session's lease from aging out (#3218).
 *
 * Two properties: the interval-vs-TTL relationship (a pure constant check — the load-bearing
 * invariant that a beat lands before the lease ages), and the behavioral proof over a `TestClock`
 * that a session live past `DEFAULT_TTL_SECONDS` stays present WITH the loop and ages out WITHOUT
 * it — driven fully in-memory against the real `TrackerRegistry` (an `RpcTest` client + the
 * registry handlers), the same transport-free idiom `session.test.ts` uses.
 */
import {assert, describe, it} from "@effect/vitest";
import {Duration, Effect, Layer} from "effect";
import {TestClock} from "effect/testing";
import {RpcTest} from "effect/unstable/rpc";
import {TrackerRegistry} from "../tracker/group.ts";
import {TrackerHandlers} from "../tracker/handlers.ts";
import {DEFAULT_TTL_SECONDS} from "../tracker/index.ts";
import {RegistryLive} from "../tracker/registry.ts";
import {
	crewHeartbeatLayer,
	HEARTBEAT_INTERVAL_SECONDS,
	HEARTBEAT_TTL_SECONDS,
} from "./heartbeat.ts";
import {CrewTracker} from "./tracker.ts";

const registryHandlers = TrackerHandlers.pipe(Layer.provide(RegistryLive));

const role = "builder";
const peer = "inbox://builder";
// Well past the TTL: the loop must refresh the lease across multiple windows to keep it live.
const pastTtl = Duration.seconds(HEARTBEAT_TTL_SECONDS * 3);

describe("crew/heartbeat — the send interval stays safely under the TTL", () => {
	it("beats more than once per TTL window, with headroom for a dropped beat", () => {
		assert.isBelow(
			HEARTBEAT_INTERVAL_SECONDS,
			HEARTBEAT_TTL_SECONDS,
			"the send interval must be under the TTL or the lease ages out between beats",
		);
		assert.isAtMost(
			HEARTBEAT_INTERVAL_SECONDS * 2,
			HEARTBEAT_TTL_SECONDS,
			"two intervals must fit in the TTL so a single missed beat is survivable",
		);
		assert.strictEqual(
			HEARTBEAT_TTL_SECONDS,
			DEFAULT_TTL_SECONDS,
			"a beat requests the tracker's default TTL, so it renews the full lease window",
		);
	});
});

describe("crew/heartbeat — a live session outlives the TTL with the loop, ages out without it", () => {
	it.effect("with the heartbeat loop, presence survives past DEFAULT_TTL_SECONDS", () =>
		Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(TrackerRegistry);
			yield* client.AnnouncePresence({peer, role, at: new Date().toISOString()});
			// Fork the keepalive loop into this scope; it refreshes the lease every interval.
			yield* Layer.build(
				crewHeartbeatLayer(peer).pipe(Layer.provide(CrewTracker.fromClient(client))),
			);
			yield* TestClock.adjust(pastTtl);
			const present = yield* client.LookupRole({role});
			assert.lengthOf(present.peers, 1, "the lease is still live — the heartbeat refreshed it");
			assert.strictEqual(present.peers[0]?.peer, peer);
		}).pipe(Effect.scoped, Effect.provide(registryHandlers)),
	);

	it.effect(
		"without the loop, the same presence ages out past DEFAULT_TTL_SECONDS (the #3218 bug)",
		() =>
			Effect.gen(function* () {
				const client = yield* RpcTest.makeClient(TrackerRegistry);
				yield* client.AnnouncePresence({peer, role, at: new Date().toISOString()});
				yield* TestClock.adjust(pastTtl);
				const present = yield* client.LookupRole({role});
				assert.lengthOf(present.peers, 0, "with no keepalive the one-shot announce ages out");
			}).pipe(Effect.scoped, Effect.provide(registryHandlers)),
	);
});
