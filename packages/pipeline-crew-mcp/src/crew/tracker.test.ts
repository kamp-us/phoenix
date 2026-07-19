/**
 * crew/tracker — the first-peer-spawn host-or-dial binding: one project socket, one live tracker.
 *
 * The socket cases need a REAL unix socket — a bind a second peer's bind can race — so they drive
 * `crewTrackerHostOrDialLayer` end to end rather than an in-memory `RpcTest` client. The bind-race
 * detector (`isTrackerAddressInUse`) is a pure unit check.
 */
import {randomUUID} from "node:crypto";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NodeFileSystem} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {Cause, Context, Effect, Layer} from "effect";
import {RpcTest} from "effect/unstable/rpc";
import {SocketServerError, SocketServerOpenError} from "effect/unstable/socket/SocketServer";
import {TrackerRegistry} from "../tracker/group.ts";
import {TrackerHandlers} from "../tracker/handlers.ts";
import {isTrackerAddressInUse} from "../tracker/index.ts";
import {RegistryLive} from "../tracker/registry.ts";
import {CrewTracker, crewTrackerHostOrDialLayer} from "./tracker.ts";

const registryHandlers = TrackerHandlers.pipe(Layer.provide(RegistryLive));

// The host layer's stale-socket reclaim reaches disk through the FileSystem seam; provide the real
// Node FileSystem so the host-or-dial layer builds in-test as under the bin's NodeServices.layer.
const hostOrDial = (socketPath: string) =>
	crewTrackerHostOrDialLayer(socketPath).pipe(Layer.provide(NodeFileSystem.layer));
const nowIso = () => new Date().toISOString();

const errWithCode = (code: string): Error => Object.assign(new Error(code), {code});

describe("crew/tracker — first-peer-spawn: two sessions on one project root, one live tracker", () => {
	it.effect("the second layer binds→EADDRINUSE→dials the first's tracker (shared registry)", () =>
		Effect.gen(function* () {
			const socketPath = join(tmpdir(), `crew-hostdial-${randomUUID().slice(0, 8)}.sock`);
			// Two concurrent sessions on ONE socket: the first hosts, the second must dial the host —
			// exactly one server binds. If two bound, they'd be two registries and the cross-lookup fails.
			const ctxA = yield* Layer.build(hostOrDial(socketPath));
			const ctxB = yield* Layer.build(hostOrDial(socketPath));
			const trackerA = Context.get(ctxA, CrewTracker);
			const trackerB = Context.get(ctxB, CrewTracker);
			// A announces; B looks it up and finds it ⇒ both speak to the SAME registry ⇒ one tracker.
			yield* trackerA.announce({
				role: "builder",
				peer: "inbox://builder",
				address: "inbox://builder",
			});
			const found = yield* trackerB.lookup("builder");
			assert.lengthOf(found, 1, "the dialing session sees the host's registry state");
			assert.strictEqual(found[0]?.address, "inbox://builder");
		}).pipe(Effect.scoped),
	);

	it.effect("a lone session hosts its own tracker (announce→lookup round-trips on one layer)", () =>
		Effect.gen(function* () {
			const socketPath = join(tmpdir(), `crew-solo-${randomUUID().slice(0, 8)}.sock`);
			const ctx = yield* Layer.build(hostOrDial(socketPath));
			const tracker = Context.get(ctx, CrewTracker);
			yield* tracker.announce({
				role: "reviewer",
				peer: "inbox://reviewer",
				address: "inbox://reviewer",
			});
			const found = yield* tracker.lookup("reviewer");
			assert.lengthOf(found, 1, "a session with no peer still has a working tracker");
		}).pipe(Effect.scoped),
	);
});

describe("crew/tracker — acquireClaim + release (the claim lifecycle client, ADR 0191 facet 3)", () => {
	it.effect("acquireClaim frees the claim on scope close so another peer can then claim it", () =>
		Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(TrackerRegistry);
			const ctx = yield* Layer.build(CrewTracker.fromClient(client));
			const tracker = Context.get(ctx, CrewTracker);
			// both holders need live presence for their claims to be live (presence-derived liveness)
			yield* client.AnnouncePresence({peer: "inbox://a", role: "builder", at: nowIso()});
			yield* client.AnnouncePresence({peer: "inbox://b", role: "reviewer", at: nowIso()});

			// hold the claim for an inner scope; while held, a foreign claim collides
			yield* Effect.scoped(
				Effect.gen(function* () {
					const reply = yield* tracker.acquireClaim({
						resource: "issue-1",
						claimant: "inbox://a",
						role: "builder",
					});
					assert.isTrue(reply.granted);
					const collided = yield* tracker.claim({
						resource: "issue-1",
						claimant: "inbox://b",
						role: "reviewer",
					});
					assert.isTrue(collided.collision, "the claim is held while its scope is open");
				}),
			);

			// scope closed ⇒ acquireClaim's Release fired ⇒ the resource is free again
			const afterRelease = yield* tracker.claim({
				resource: "issue-1",
				claimant: "inbox://b",
				role: "reviewer",
			});
			assert.isTrue(afterRelease.granted, "the claim was released on scope close");
		}).pipe(Effect.scoped, Effect.provide(registryHandlers)),
	);

	it.effect("release frees a claim explicitly (the lane-finish fast path)", () =>
		Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(TrackerRegistry);
			const ctx = yield* Layer.build(CrewTracker.fromClient(client));
			const tracker = Context.get(ctx, CrewTracker);
			yield* client.AnnouncePresence({peer: "inbox://a", role: "builder", at: nowIso()});
			yield* client.AnnouncePresence({peer: "inbox://b", role: "reviewer", at: nowIso()});
			yield* tracker.claim({resource: "issue-1", claimant: "inbox://a", role: "builder"});
			yield* tracker.release({resource: "issue-1", claimant: "inbox://a"});
			const reclaim = yield* tracker.claim({
				resource: "issue-1",
				claimant: "inbox://b",
				role: "reviewer",
			});
			assert.isTrue(reclaim.granted, "the explicitly-released resource is free");
		}).pipe(Effect.scoped, Effect.provide(registryHandlers)),
	);
});

describe("crew/tracker — isTrackerAddressInUse (the bind-race detector the dial fallback keys on)", () => {
	it("is true for a SocketServerError whose open cause is EADDRINUSE", () => {
		const error = new SocketServerError({
			reason: new SocketServerOpenError({cause: errWithCode("EADDRINUSE")}),
		});
		assert.isTrue(isTrackerAddressInUse(Cause.fail(error)));
	});

	it("is false for a non-EADDRINUSE bind failure (it must propagate, never be dialed over)", () => {
		const error = new SocketServerError({
			reason: new SocketServerOpenError({cause: errWithCode("EACCES")}),
		});
		assert.isFalse(isTrackerAddressInUse(Cause.fail(error)));
	});

	it("is false for an unrelated failure", () => {
		assert.isFalse(isTrackerAddressInUse(Cause.fail(new Error("not a bind error"))));
	});
});
