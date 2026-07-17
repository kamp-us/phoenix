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
import {assert, describe, it} from "@effect/vitest";
import {Cause, Context, Effect, Layer, Option} from "effect";
import {SocketServerError, SocketServerOpenError} from "effect/unstable/socket/SocketServer";
import {isTrackerAddressInUse} from "../tracker/index.ts";
import {CrewTracker, crewTrackerHostOrDialLayer} from "./tracker.ts";

const errWithCode = (code: string): Error => Object.assign(new Error(code), {code});

describe("crew/tracker — first-peer-spawn: two sessions on one project root, one live tracker", () => {
	it.effect("the second layer binds→EADDRINUSE→dials the first's tracker (shared registry)", () =>
		Effect.gen(function* () {
			const socketPath = join(tmpdir(), `crew-hostdial-${randomUUID().slice(0, 8)}.sock`);
			// Two concurrent sessions on ONE socket: the first hosts, the second must dial the host —
			// exactly one server binds. If two bound, they'd be two registries and the cross-lookup fails.
			const ctxA = yield* Layer.build(crewTrackerHostOrDialLayer(socketPath));
			const ctxB = yield* Layer.build(crewTrackerHostOrDialLayer(socketPath));
			const trackerA = Context.get(ctxA, CrewTracker);
			const trackerB = Context.get(ctxB, CrewTracker);
			// A announces; B looks it up and finds it ⇒ both speak to the SAME registry ⇒ one tracker.
			yield* trackerA.announce({
				role: "builder",
				peer: "inbox://builder",
				address: "inbox://builder",
			});
			const found = yield* trackerB.lookup("builder");
			assert.isTrue(Option.isSome(found), "the dialing session sees the host's registry state");
			if (Option.isSome(found)) assert.strictEqual(found.value.address, "inbox://builder");
		}).pipe(Effect.scoped),
	);

	it.effect("a lone session hosts its own tracker (announce→lookup round-trips on one layer)", () =>
		Effect.gen(function* () {
			const socketPath = join(tmpdir(), `crew-solo-${randomUUID().slice(0, 8)}.sock`);
			const ctx = yield* Layer.build(crewTrackerHostOrDialLayer(socketPath));
			const tracker = Context.get(ctx, CrewTracker);
			yield* tracker.announce({
				role: "reviewer",
				peer: "inbox://reviewer",
				address: "inbox://reviewer",
			});
			const found = yield* tracker.lookup("reviewer");
			assert.isTrue(Option.isSome(found), "a session with no peer still has a working tracker");
		}).pipe(Effect.scoped),
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
