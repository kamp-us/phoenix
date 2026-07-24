/**
 * The socket transport: the per-project socket path derivation, the control-plane-only served
 * surface (no relay kinds), a real unix-socket announce→lookup round-trip proving the tracker runs
 * as an `RpcServer` over `layerProtocolSocketServer`, and the stale-socket crash-recovery contract
 * (#3280 — reclaim a crashed host's orphaned socket, never reclaim a live one).
 */
import {spawn} from "node:child_process";
import {randomUUID} from "node:crypto";
import {existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NodeFileSystem, NodeSocket} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Exit, Layer} from "effect";
import {RpcClient, RpcSerialization} from "effect/unstable/rpc";
import {TrackerRegistry} from "./group.ts";
import {rendezvousSocketPathFor} from "./rendezvous.ts";
import {isTrackerAddressInUse, trackerServerLayer} from "./server.ts";

// trackerServerLayer's stale-socket reclaim now reaches disk through the FileSystem seam, so provide
// the real Node FileSystem — the layer builds in-test exactly as under the bin's NodeServices.layer.
const hostedTracker = (socketPath: string) =>
	trackerServerLayer(socketPath).pipe(Layer.provide(NodeFileSystem.layer));

describe("tracker socket path — derived from the canonical repo key", () => {
	it("is deterministic in the repo key", () => {
		assert.strictEqual(
			rendezvousSocketPathFor("/repo/.git"),
			rendezvousSocketPathFor("/repo/.git"),
		);
	});
	it("differs across repos and is a well-formed .sock path", () => {
		assert.notStrictEqual(rendezvousSocketPathFor("/a/.git"), rendezvousSocketPathFor("/b/.git"));
		assert.match(rendezvousSocketPathFor("/a/.git"), /kampus-crew-[0-9a-f]{16}\.sock$/);
	});
});

describe("tracker served surface — control-plane only", () => {
	it("serves exactly the six registry kinds and no message-relay kind", () => {
		assert.deepStrictEqual([...TrackerRegistry.requests.keys()].sort(), [
			"AnnouncePresence",
			"Claim",
			"Heartbeat",
			"LookupClaim",
			"LookupRole",
			"Release",
		]);
		for (const relay of ["DrainProgress", "IntakePing", "EngineNudge"]) {
			assert.isFalse(
				TrackerRegistry.requests.has(relay),
				`tracker must not serve relay kind ${relay}`,
			);
		}
	});
});

const socketClientLayer = (socketPath: string) =>
	RpcClient.layerProtocolSocket().pipe(
		Layer.provide([NodeSocket.layerNet({path: socketPath}), RpcSerialization.layerNdjson]),
	);

describe("tracker over a unix socket — RpcServer round-trip", () => {
	it.effect("announce then lookup round-trips over layerProtocolSocketServer", () => {
		const socketPath = join(tmpdir(), `crew-test-${randomUUID().slice(0, 8)}.sock`);
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
			Effect.provide(Layer.mergeAll(socketClientLayer(socketPath), hostedTracker(socketPath))),
			Effect.scoped,
		);
	});
});

/**
 * Faithfully reproduce a crashed tracker host: a child binds `socketPath`, then `SIGKILL` leaves the
 * `.sock` file on disk with no listener. node unlinks the socket file only on a CLEAN `server.close()`,
 * so an ungraceful exit is what strands it — exactly the crash path this hardens. The stranded file
 * then refuses a connect with `ECONNREFUSED`, the stale signal `reclaimStaleSocket` keys on (#3280).
 */
const leaveStaleSocket = (socketPath: string): Effect.Effect<void> =>
	Effect.callback<void>((resume) => {
		const source = `const net=require("node:net");const s=net.createServer();s.listen(${JSON.stringify(
			socketPath,
		)},()=>process.stdout.write("L"));setInterval(()=>{},1000);`;
		const child = spawn(process.execPath, ["-e", source]);
		child.stdout.on("data", (chunk) => {
			if (String(chunk).includes("L")) {
				child.once("exit", () => resume(Effect.void));
				child.kill("SIGKILL");
			}
		});
	});

describe("tracker stale-socket crash recovery (#3280)", () => {
	// `it.live`: spawns a real child + SIGKILLs it, so it needs real time, not the frozen TestClock.
	it.live(
		"reclaims a crashed host's stale socket and re-hosts the tracker",
		() => {
			const socketPath = join(tmpdir(), `crew-stale-${randomUUID().slice(0, 8)}.sock`);
			return Effect.gen(function* () {
				// Strand the stale socket BEFORE the tracker layer is built — the layer runs reclaim at
				// build time, so building it must observe the crashed host's orphaned file, not a clean path.
				yield* leaveStaleSocket(socketPath);
				assert.isTrue(
					existsSync(socketPath),
					"expected a stale socket file after the simulated crash",
				);
				// Build the server FIRST so it reclaims the stale file and is listening, THEN dial a client
				// (the production sequencing: `crewTrackerHostOrDialLayer` provides the client onto the
				// hosted server). A successful round-trip proves the reclaim re-hosted the tracker.
				yield* Layer.build(hostedTracker(socketPath));
				const result = yield* Effect.gen(function* () {
					const client = yield* RpcClient.make(TrackerRegistry);
					yield* client.AnnouncePresence({
						peer: "inbox://peer-a",
						role: "builder",
						at: "2026-07-16T10:00:00Z",
					});
					return yield* client.LookupRole({role: "builder"});
				}).pipe(Effect.provide(socketClientLayer(socketPath)));
				assert.strictEqual(result.peers[0]?.peer, "inbox://peer-a");
			}).pipe(Effect.scoped);
		},
		20_000,
	); // a real node child spawn + SIGKILL + rebind (node + TS + Effect startup)

	it.effect(
		"leaves a LIVE socket intact — a second bind still gets EADDRINUSE (dial, not reclaim)",
		() => {
			const socketPath = join(tmpdir(), `crew-live-${randomUUID().slice(0, 8)}.sock`);
			return Effect.gen(function* () {
				// host A is live for the scope; reclaim must NOT unlink it out from under the running host.
				yield* Layer.build(hostedTracker(socketPath));
				const exit = yield* Effect.exit(Layer.build(hostedTracker(socketPath)));
				assert.isTrue(
					Exit.isFailure(exit),
					"a second bind on a LIVE socket must fail, not reclaim",
				);
				if (Exit.isFailure(exit)) {
					assert.isTrue(
						isTrackerAddressInUse(exit.cause),
						"the live socket must surface EADDRINUSE (the dial signal), proving it was not reclaimed",
					);
				}
				// host A keeps serving after the refused second bind — the graceful happy path is unchanged.
				const client = yield* RpcClient.make(TrackerRegistry);
				yield* client.AnnouncePresence({
					peer: "inbox://peer-a",
					role: "builder",
					at: "2026-07-16T10:00:00Z",
				});
				const result = yield* client.LookupRole({role: "builder"});
				assert.strictEqual(result.peers[0]?.peer, "inbox://peer-a");
			}).pipe(Effect.provide(socketClientLayer(socketPath)), Effect.scoped);
		},
	);
});
