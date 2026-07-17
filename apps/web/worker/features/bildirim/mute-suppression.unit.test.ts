/**
 * Bildirim mute-suppression seam (#3238, ADR 0188) — the decisions that are
 * wrong-or-right with no database (ADR 0082 T1/T2): the flag gate (default-off ⇒ no
 * suppression), the null-actor short-circuit (a system moment suppresses nobody), and
 * the viewer-scoped membership test (`recipient` = the muter, suppress iff the
 * recipient muted the actor). Row-level EXCLUSION against real D1 (a muted member's
 * interaction actually raising no bildirim end-to-end) is the integration tier's job,
 * like the content read-mask.
 *
 * The `Mute` stub either returns a fixed set or DIES on contact, so a path that must
 * short-circuit before the read (null actor / flag off) proves it never reaches `Mute`.
 */
import {assert, describe, it} from "@effect/vitest";
import {CurrentUser} from "@kampus/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Effect, Layer} from "effect";
import {Flags} from "../flagship/Flags.ts";
import {RequestFlagOverrides} from "../flagship/FlagsContext.ts";
import {Mute} from "../mute/Mute.ts";
import {bildirimMutedBy} from "./mute-suppression.ts";

const runtimeContextStub: BaseRuntimeContext = {
	Type: "bildirim-mute-suppression-test",
	id: "bildirim-mute-suppression-test",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
};

const flagsStub = (on: boolean): Layer.Layer<Flags> =>
	Layer.succeed(Flags, {
		getBoolean: () => Effect.succeed(on),
		getString: () => Effect.die("getString not exercised"),
		getNumber: () => Effect.die("getNumber not exercised"),
		getObject: () => Effect.die("getObject not exercised"),
	} as typeof Flags.Service);

// A `Mute` whose `readMutedIds` returns a fixed set — or dies on contact, proving a
// path that must short-circuit before the read (null actor / flag off) never reaches it.
const muteStub = (
	readMutedIds?: (viewerId: string | null | undefined) => Effect.Effect<Set<string>>,
) =>
	Layer.succeed(Mute, {
		set: () => Effect.die("Mute.set not exercised"),
		listMine: () => Effect.die("Mute.listMine not exercised"),
		readMutedIds:
			readMutedIds ??
			(() => Effect.die("Mute.readMutedIds reached on a path that must short-circuit")),
	});

const resolve = (opts: {
	on: boolean;
	recipientId: string;
	actorId: string | null | undefined;
	mute: ReturnType<typeof muteStub>;
}) =>
	bildirimMutedBy(opts.recipientId, opts.actorId).pipe(
		// The recipient IS the muter, passed explicitly — `CurrentUser` here is only what
		// `provideRequestFlags` reads to build the flag context, never the muted-id scope.
		Effect.provideService(CurrentUser, {user: {id: opts.recipientId} as never}),
		Effect.provideService(RuntimeContext, runtimeContextStub),
		Effect.provideService(RequestFlagOverrides, {cookieHeader: null, overridesAllowed: false}),
		Effect.provide(Layer.mergeAll(flagsStub(opts.on), opts.mute)),
	);

describe("bildirimMutedBy — flag-gated, viewer-scoped suppression", () => {
	it.effect("a null actor is a system moment ⇒ not suppressed, Mute never read", () =>
		Effect.gen(function* () {
			const suppressed = yield* resolve({
				on: true,
				recipientId: "u-muter",
				actorId: null,
				mute: muteStub(),
			});
			assert.isFalse(suppressed);
		}),
	);

	it.effect("flag OFF ⇒ never suppressed, and Mute is never read (byte-for-byte today)", () =>
		Effect.gen(function* () {
			const suppressed = yield* resolve({
				on: false,
				recipientId: "u-muter",
				actorId: "u-actor",
				mute: muteStub(),
			});
			assert.isFalse(suppressed);
		}),
	);

	it.effect("flag ON + the actor is NOT muted ⇒ delivered (not suppressed)", () =>
		Effect.gen(function* () {
			const suppressed = yield* resolve({
				on: true,
				recipientId: "u-muter",
				actorId: "u-actor",
				mute: muteStub(() => Effect.succeed(new Set(["u-someone-else"]))),
			});
			assert.isFalse(suppressed);
		}),
	);

	it.effect("flag ON + the recipient muted the actor ⇒ suppressed (viewer-scoped)", () =>
		Effect.gen(function* () {
			const suppressed = yield* resolve({
				on: true,
				recipientId: "u-muter",
				actorId: "u-actor",
				mute: muteStub((viewerId) => {
					assert.strictEqual(
						viewerId,
						"u-muter",
						"reads the RECIPIENT's mutes (the muter), never the actor's",
					);
					return Effect.succeed(new Set(["u-actor"]));
				}),
			});
			assert.isTrue(suppressed);
		}),
	);
});
