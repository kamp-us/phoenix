/**
 * The socket transport: the per-project socket path derivation, the control-plane-only served
 * surface (no relay kinds), and a real unix-socket announce→lookup round-trip proving the tracker
 * runs as an `RpcServer` over `layerProtocolSocketServer`.
 */
import {randomUUID} from "node:crypto";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NodeSocket} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer} from "effect";
import {RpcClient, RpcSerialization} from "effect/unstable/rpc";
import {TrackerRegistry} from "./group.ts";
import {socketPathFor, trackerServerLayer} from "./server.ts";

describe("tracker socket path — per-project derivation", () => {
	it("is deterministic and normalizes the root", () => {
		assert.strictEqual(socketPathFor("/some/project"), socketPathFor("/some/project/"));
	});
	it("differs across projects and is a well-formed .sock path", () => {
		assert.notStrictEqual(socketPathFor("/project/a"), socketPathFor("/project/b"));
		assert.match(socketPathFor("/project/a"), /kampus-crew-[0-9a-f]{16}\.sock$/);
	});
});

describe("tracker served surface — control-plane only", () => {
	it("serves exactly the five registry kinds and no message-relay kind", () => {
		assert.deepStrictEqual([...TrackerRegistry.requests.keys()].sort(), [
			"AnnouncePresence",
			"Claim",
			"Heartbeat",
			"LookupRole",
			"Release",
		]);
		for (const relay of ["AckInbox", "DrainProgress", "EpicHandoff", "IntakePing"]) {
			assert.isFalse(
				TrackerRegistry.requests.has(relay),
				`tracker must not serve relay kind ${relay}`,
			);
		}
	});
});

describe("tracker over a unix socket — RpcServer round-trip", () => {
	it.effect("announce then lookup round-trips over layerProtocolSocketServer", () => {
		const socketPath = join(tmpdir(), `crew-test-${randomUUID().slice(0, 8)}.sock`);
		const clientLayer = RpcClient.layerProtocolSocket().pipe(
			Layer.provide([NodeSocket.layerNet({path: socketPath}), RpcSerialization.layerNdjson]),
		);
		return Effect.gen(function* () {
			const client = yield* RpcClient.make(TrackerRegistry);
			yield* client.AnnouncePresence({
				peer: "inbox://peer-a",
				role: "builder",
				at: "2026-07-16T10:00:00Z",
			});
			const result = yield* client.LookupRole({role: "builder"});
			assert.strictEqual(result.role, "builder");
			assert.lengthOf(result.peers, 1);
			assert.strictEqual(result.peers[0]?.peer, "inbox://peer-a");
		}).pipe(
			Effect.provide(Layer.mergeAll(clientLayer, trackerServerLayer(socketPath))),
			Effect.scoped,
		);
	});
});
