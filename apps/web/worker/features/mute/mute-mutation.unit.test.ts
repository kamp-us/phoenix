/**
 * `mute.set` / `mute.remove` WIRE-boundary coverage (#3112, epic #2035) — the
 * decisions that are wrong-or-right with no database (ADR 0082), driven through the
 * real external interface (`resolveWire`: decode + the `encodeWireError`
 * class→wire-code seam), so a denial's wire `code` is what a client gets.
 *
 * The load-bearing ACs:
 *   - gated on `CurrentUser`: an anonymous caller is rejected the invisible
 *     `UNAUTHORIZED` before any read (the `Mute` stub is fail-on-contact);
 *   - dark-ship: with the `member-mute` flag OFF both fail `MUTE_DISABLED` before the
 *     write, so an unreleased mute never runs;
 *   - with the flag ON an authed muter's set/remove reaches `Mute.set` and the receipt
 *     carries the post-write presence; a self-mute surfaces `SELF_MUTE_REJECTED`.
 *
 * The real-D1 presence idempotency + set/readMutedIds round-trip live in
 * `Mute.unit.test.ts` (the domain seam) and the integration tier once the read-mask +
 * manage UI siblings wire an HTTP/fate surface to drive Mute black-box over.
 */
import {assert, describe, it} from "@effect/vitest";
import {CurrentUser} from "@kampus/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Cause, Effect, Exit, Layer} from "effect";
import {UserId} from "../../lib/ids.ts";
import {resolveWire} from "../fate/resolve-wire.testing.ts";
import {Flags} from "../flagship/Flags.ts";
import {SelfMuteRejected} from "./errors.ts";
import {Mute, type MuteSetInput, type MuteSetResult} from "./Mute.ts";
import {mutations} from "./mutations.ts";

const MUTER = {id: "u-muter", email: "kaan@example.com", name: "kaan"};

const runtimeContextStub: BaseRuntimeContext = {
	Type: "mute-mutation-test",
	id: "mute-mutation-test",
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

// A `Mute` whose `set` runs `impl` (or dies on contact) — so a denied path that must
// short-circuit before the write proves it by failing the fail-on-contact default.
const muteStub = (impl?: (input: MuteSetInput) => Effect.Effect<MuteSetResult, SelfMuteRejected>) =>
	Layer.succeed(Mute, {
		set: impl ?? (() => Effect.die("Mute.set reached on a path that must short-circuit")),
		readMutedIds: () => Effect.die("Mute.readMutedIds not exercised"),
		listMine: () => Effect.die("Mute.listMine not exercised"),
	});

const setMute = (mutedId: string, user?: typeof MUTER) =>
	resolveWire(mutations["mute.set"], {input: {mutedId}, select: ["id", "isMuted", "changed"]}).pipe(
		Effect.provideService(CurrentUser, {user}),
		Effect.provideService(RuntimeContext, runtimeContextStub),
	);

const removeMute = (mutedId: string, user?: typeof MUTER) =>
	resolveWire(mutations["mute.remove"], {
		input: {mutedId},
		select: ["id", "isMuted", "changed"],
	}).pipe(
		Effect.provideService(CurrentUser, {user}),
		Effect.provideService(RuntimeContext, runtimeContextStub),
	);

const wireCodeOf = (cause: Cause.Cause<unknown>): unknown => {
	const error = Cause.findErrorOption(cause);
	return error._tag === "Some" ? (error.value as {code?: unknown}).code : undefined;
};

describe("mute.set / mute.remove — CurrentUser gate + dark-ship (fail closed)", () => {
	it.effect("an anonymous caller is rejected UNAUTHORIZED — and never reaches the write", () =>
		Effect.gen(function* () {
			const exit = yield* setMute("u-target").pipe(Effect.exit);
			assert.isTrue(Exit.isFailure(exit));
			if (Exit.isFailure(exit)) assert.strictEqual(wireCodeOf(exit.cause), "UNAUTHORIZED");
		}).pipe(Effect.provide(Layer.mergeAll(flagsStub(true), muteStub()))),
	);

	it.effect("with the flag OFF an authed muter is refused MUTE_DISABLED — no write", () =>
		Effect.gen(function* () {
			const exit = yield* setMute("u-target", MUTER).pipe(Effect.exit);
			assert.isTrue(Exit.isFailure(exit));
			if (Exit.isFailure(exit)) assert.strictEqual(wireCodeOf(exit.cause), "MUTE_DISABLED");
		}).pipe(Effect.provide(Layer.mergeAll(flagsStub(false), muteStub()))),
	);

	it.effect("with the flag ON an authed muter mutes; the receipt reports the presence", () =>
		Effect.gen(function* () {
			const receipt = yield* setMute("u-target", MUTER);
			assert.deepStrictEqual(receipt, {
				__typename: "MuteReceipt",
				id: "u-target",
				isMuted: true,
				changed: true,
			});
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					flagsStub(true),
					muteStub((input) => {
						assert.strictEqual(input.muterId, MUTER.id, "the muter is the authed caller");
						assert.strictEqual(input.value, true, "mute.set writes value=true");
						return Effect.succeed({mutedId: input.mutedId, isMuted: true, changed: true});
					}),
				),
			),
		),
	);

	it.effect("with the flag ON mute.remove un-mutes; the receipt reports not-muted", () =>
		Effect.gen(function* () {
			const receipt = yield* removeMute("u-target", MUTER);
			assert.deepStrictEqual(receipt, {
				__typename: "MuteReceipt",
				id: "u-target",
				isMuted: false,
				changed: true,
			});
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					flagsStub(true),
					muteStub((input) => {
						assert.strictEqual(input.value, false, "mute.remove writes value=false");
						return Effect.succeed({mutedId: input.mutedId, isMuted: false, changed: true});
					}),
				),
			),
		),
	);

	it.effect("a self-mute surfaces the SELF_MUTE_REJECTED wire code", () =>
		Effect.gen(function* () {
			const exit = yield* setMute(MUTER.id, MUTER).pipe(Effect.exit);
			assert.isTrue(Exit.isFailure(exit));
			if (Exit.isFailure(exit)) assert.strictEqual(wireCodeOf(exit.cause), "SELF_MUTE_REJECTED");
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					flagsStub(true),
					muteStub((input) =>
						Effect.fail(
							new SelfMuteRejected({
								memberId: UserId.make(input.muterId),
								message: "a member cannot mute themselves",
							}),
						),
					),
				),
			),
		),
	);
});
