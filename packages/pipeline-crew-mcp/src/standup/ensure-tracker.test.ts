/**
 * The ensure-tracker-running step's two behaviors, both asserted against the actual socket-bind
 * outcome: `tryBecomeTracker` classifies start-if-absent vs reuse-if-present in-process, and
 * `ensureTrackerRunning` spawns the standing tracker as a detached process that serves the socket and
 * survives a second stand-up (which reuses it via EADDRINUSE rather than double-binding).
 */
import {randomUUID} from "node:crypto";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NodeSocket} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer} from "effect";
import {RpcClient, RpcSerialization} from "effect/unstable/rpc";
import {socketPathFor, TrackerRegistry, trackerServerLayer} from "../tracker/index.ts";
import {ensureTrackerRunning, tryBecomeTracker} from "./ensure-tracker.ts";

const freshSocketPath = () => join(tmpdir(), `ensure-tracker-${randomUUID().slice(0, 8)}.sock`);

const clientLayer = (socketPath: string) =>
	RpcClient.layerProtocolSocket().pipe(
		Layer.provide([NodeSocket.layerNet({path: socketPath}), RpcSerialization.layerNdjson]),
	);

// Reap the detached standing tracker so the suite leaves nothing running; a `kill` on an
// already-exited child (the reuse child exits on EADDRINUSE) throws ESRCH, which we ignore.
const reap = (pid: number | undefined) =>
	pid === undefined ? Effect.void : Effect.try(() => process.kill(pid)).pipe(Effect.ignore);

describe("tryBecomeTracker — the bind-outcome core", () => {
	it.effect("start-if-absent: an unbound socket is won ('started') and served afterward", () => {
		const socketPath = freshSocketPath();
		return Effect.gen(function* () {
			const outcome = yield* tryBecomeTracker(socketPath);
			assert.strictEqual(outcome, "started");
			// served afterward: a client round-trips through the just-started tracker.
			const client = yield* RpcClient.make(TrackerRegistry);
			yield* client.AnnouncePresence({
				peer: "inbox://peer-a",
				role: "builder",
				at: "2026-07-16T10:00:00Z",
			});
			const result = yield* client.LookupRole({role: "builder"});
			assert.strictEqual(result.peers[0]?.peer, "inbox://peer-a");
		}).pipe(Effect.provide(clientLayer(socketPath)), Effect.scoped);
	});

	it.effect(
		"reuse-if-present: a second bind on a served socket reuses it ('already-serving')",
		() => {
			const socketPath = freshSocketPath();
			return Effect.gen(function* () {
				// A tracker is already serving this socket (built into the scope).
				yield* Layer.build(trackerServerLayer(socketPath));
				// The second attempt must not crash or double-bind — it reads the EADDRINUSE reuse signal.
				const outcome = yield* tryBecomeTracker(socketPath);
				assert.strictEqual(outcome, "already-serving");
			}).pipe(Effect.scoped);
		},
	);
});

describe("ensureTrackerRunning — the detached standing process", () => {
	// `it.live`, not `it.effect`: this spawns a real detached node process and polls the socket with
	// real-time `Effect.sleep` — the default TestClock would freeze that poll (sleep never elapses).
	it.live(
		"starts a detached tracker that serves the socket and reuses it on a second stand-up",
		() => {
			const projectDir = mkdtempSync(join(tmpdir(), "ensure-tracker-proj-"));
			const socketPath = socketPathFor(projectDir);
			return Effect.gen(function* () {
				// First stand-up: no tracker running -> a detached child is spawned and serves the socket.
				const started = yield* ensureTrackerRunning(projectDir);
				assert.strictEqual(started.socketPath, socketPath);
				assert.isNumber(started.pid);

				// A client round-trip proves the detached child is actually serving.
				yield* Effect.gen(function* () {
					const client = yield* RpcClient.make(TrackerRegistry);
					yield* client.AnnouncePresence({
						peer: "inbox://peer-a",
						role: "builder",
						at: "2026-07-16T10:00:00Z",
					});
					const result = yield* client.LookupRole({role: "builder"});
					assert.strictEqual(result.peers[0]?.peer, "inbox://peer-a");
				}).pipe(Effect.provide(clientLayer(socketPath)), Effect.scoped);

				// Second stand-up: the tracker already serves -> reuse (no crash, no double-bind).
				const reused = yield* ensureTrackerRunning(projectDir);
				assert.strictEqual(reused.socketPath, socketPath);

				// The standing tracker is a detached child that outlives this test process; reap both.
				yield* reap(started.pid);
				yield* reap(reused.pid);
			}).pipe(
				Effect.ensuring(Effect.sync(() => rmSync(projectDir, {recursive: true, force: true}))),
			);
		},
		30_000,
	); // two real detached node child spawns (each ~1-3s of node + TS + Effect startup)
});
