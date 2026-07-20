/**
 * crew/channel-server — the REAL unix-socket transport of the inbox server, the seam the
 * in-memory `RpcTest`/in-process-`Connect` tests never exercise. Covers:
 *   - a real IntakePing round-trip: production `inboxServerSocketLayer` (NDJSON over a unix
 *     socket) driven by the production `crewSocketDialerLayer`, asserting the InboxAck returns
 *     and the recipient wakes with the {content, meta} contract;
 *   - the stale-socket bind (#3489): a crashed prior process's orphaned socket file at
 *     `inboxSocketPathFor(address)` is reclaimed (`reclaimStaleSocket`, #3280), so the server
 *     still binds instead of dying with `SocketServerError: Open`;
 *   - the guard: a genuinely LIVE listener at the path is NOT reclaimed — a second bind fails.
 *
 * Uses `it.live`, not `it.effect`: `it.effect` runs under a virtual TestClock where `Effect.sleep`
 * (the server-boot settle) never advances and the test hangs; the stale case also spawns a real
 * child + SIGKILL, which needs real time.
 */
import {spawn} from "node:child_process";
import {existsSync} from "node:fs";
import {NodeFileSystem} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Exit, Layer, Ref} from "effect";
import {type ChannelNotificationPayload, ChannelSink} from "../edge/index.ts";
import {Dialer, type InboxEnvelope} from "../peer/index.ts";
import {
	crewSocketDialerLayer,
	inboxServerSocketLayer,
	inboxSocketPathFor,
} from "./channel-server.ts";

const freshAddress = () => `inbox://engine/${Math.random().toString(36).slice(2)}`;

// A sink that records every wake, so the round-trip can assert the delivery reached the edge.
const recordingSink = (wakes: Ref.Ref<ReadonlyArray<ChannelNotificationPayload>>) =>
	Layer.succeed(ChannelSink, {
		wake: (payload) => Ref.update(wakes, (xs) => [...xs, payload]),
	});

const discardingSink = Layer.succeed(ChannelSink, {wake: () => Effect.void});

/**
 * Faithfully reproduce a crashed process's orphaned inbox socket: a child binds `socketPath`, then
 * `SIGKILL` leaves the `.sock` file on disk with no listener (node only unlinks on a CLEAN close).
 * The stranded file refuses a connect with `ECONNREFUSED` — the stale signal `reclaimStaleSocket`
 * keys on (#3280). Mirrors `tracker/server.test.ts`'s `leaveStaleSocket`.
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

describe("crew/channel-server — REAL unix-socket inbox transport", () => {
	it.live(
		"a valid IntakePing crosses the socket, returns an InboxAck, and wakes the recipient",
		() =>
			Effect.gen(function* () {
				const address = freshAddress();
				const socketPath = inboxSocketPathFor(address);
				const wakes = yield* Ref.make<ReadonlyArray<ChannelNotificationPayload>>([]);
				// The reclaim now reaches disk through the `FileSystem` seam, so provide the real Node
				// FileSystem — the layer builds in-test exactly as under the bin's `NodeServices.layer`.
				const serverLayer = inboxServerSocketLayer(address).pipe(
					Layer.provide([recordingSink(wakes), NodeFileSystem.layer]),
				);

				const result = yield* Effect.gen(function* () {
					yield* Effect.sleep("400 millis"); // let the socket server bind + listen
					assert.isTrue(existsSync(socketPath), "inbox socket must be listening");

					const envelope: InboxEnvelope = {
						messageId: "m-roundtrip-1",
						from: "inbox://engineering-manager/1",
						kind: "IntakePing",
						body: {issue: 3489, from: "engineering-manager", at: new Date().toISOString()},
						at: new Date().toISOString(),
					};
					const dialer = yield* Dialer;
					const ack = yield* dialer.send(address, envelope).pipe(Effect.timeout("6 seconds"));
					return {ack, wakes: yield* Ref.get(wakes)};
				}).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(crewSocketDialerLayer, serverLayer)));

				assert.strictEqual(result.ack.by, address, "the ack is stamped by the recipient inbox");
				assert.strictEqual(result.ack.messageId, "m-roundtrip-1", "the ack echoes the messageId");
				assert.lengthOf(result.wakes, 1, "the recipient inbox woke exactly once");
				assert.match(result.wakes[0]?.content ?? "", /IntakePing/, "the wake carries the kind");
				assert.strictEqual(
					result.wakes[0]?.meta?.from,
					"inbox://engineering-manager/1",
					"the wake meta.from echoes the sender ({content, meta} contract)",
				);
			}),
		{timeout: 20000},
	);

	it.live(
		"reclaims a crashed prior process's STALE socket and still binds (not SocketServerError: Open, #3489)",
		() =>
			Effect.gen(function* () {
				const address = freshAddress();
				const socketPath = inboxSocketPathFor(address);
				// Strand the stale socket BEFORE the layer builds — the reclaim runs at build time, so the
				// bind must observe the crashed process's orphaned file, not a clean path.
				yield* leaveStaleSocket(socketPath);
				assert.isTrue(
					existsSync(socketPath),
					"precondition: a stale inbox socket occupies the path",
				);

				const exit = yield* Effect.scoped(
					Effect.gen(function* () {
						const built = yield* Layer.build(
							inboxServerSocketLayer(address).pipe(
								Layer.provide([discardingSink, NodeFileSystem.layer]),
							),
						).pipe(Effect.exit);
						assert.isTrue(
							existsSync(socketPath),
							"the inbox socket is listening after the reclaim + bind",
						);
						return built;
					}),
				);
				assert.isTrue(Exit.isSuccess(exit), "a stale socket file must not crash the bind");
			}),
		{timeout: 20000},
	);

	it.live(
		"does NOT reclaim a genuinely-live listener at the path — a second bind fails (#3489 guard)",
		() =>
			Effect.gen(function* () {
				const address = freshAddress();
				const socketPath = inboxSocketPathFor(address);

				yield* Effect.scoped(
					Effect.gen(function* () {
						// Stand up a LIVE inbox server first, held for this scope.
						yield* Layer.build(
							inboxServerSocketLayer(address).pipe(
								Layer.provide([discardingSink, NodeFileSystem.layer]),
							),
						);
						yield* Effect.sleep("300 millis");
						assert.isTrue(existsSync(socketPath), "the live listener is bound");

						// A second bind at the same (live) path must FAIL — reclaim skips the unlink when the
						// connect succeeds, so the raw bind rejects with EADDRINUSE (the live socket is untouched).
						const second = yield* Layer.build(
							inboxServerSocketLayer(address).pipe(
								Layer.provide([discardingSink, NodeFileSystem.layer]),
							),
						).pipe(Effect.exit);
						assert.isTrue(
							Exit.isFailure(second),
							"a live listener must not be reclaimed — the second bind fails closed",
						);
						assert.isTrue(existsSync(socketPath), "the live listener's socket file is untouched");
					}),
				);
			}),
		{timeout: 20000},
	);
});
