/**
 * `user.banUser` / `user.unbanUser` WIRE-boundary coverage (#970, admin epic #968) —
 * the authority + dark-ship decisions that are wrong-or-right with no database (ADR
 * 0082), driven through the real external interface (`resolveWire`: decode + the
 * `encodeWireError` class→wire-code seam), so a denial's wire `code` is what a client
 * gets.
 *
 * The load-bearing AC (#970): ban and unban each FAIL CLOSED for a non-admin caller
 * — a non-holder of the `admin` relation and the anonymous actor both get the
 * invisible `UNAUTHORIZED` (they can't tell "not admin" from "not signed in", ADR
 * 0098 §2), and neither reaches the write (the `Pasaport` stub is fail-on-contact).
 * Plus the dark-ship: with the `phoenix-user-ban` flag OFF the path is inert (fails
 * `Denied` before any authority check or write), so an unreleased ban never runs. The
 * real-D1 write→read + session-refusal round-trip is
 * `apps/web/tests/integration/pasaport-ban.test.ts`.
 */
import {assert, describe, it} from "@effect/vitest";
import {
	type Actor,
	AgentAuthority,
	CurrentActor,
	human,
	RelationStore,
	unauthenticated,
} from "@kampus/authz";
import {CurrentUser} from "@kampus/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Cause, Effect, Exit, Layer} from "effect";
import {resolveWire} from "../fate/resolve-wire.testing.ts";
import {Flags} from "../flagship/Flags.ts";
import {mutations} from "./mutations.ts";
import {makePasaportStub} from "./Pasaport.testing.ts";

const runtimeContextStub: BaseRuntimeContext = {
	Type: "ban-test",
	id: "ban-test",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
};

const flagsStub = (on: boolean): Layer.Layer<Flags> =>
	Layer.succeed(
		Flags,
		// biome-ignore lint/plugin: a Flags test double — only getBoolean is exercised on this path.
		{
			getBoolean: () => Effect.succeed(on),
			getString: () => Effect.die(new Error("unused")),
			getNumber: () => Effect.die(new Error("unused")),
			getObject: () => Effect.die(new Error("unused")),
		} as unknown as typeof Flags.Service,
	);

const agentAuthorityStub = Layer.succeed(AgentAuthority, {admits: () => Effect.succeed(false)});

// A `RelationStore` where exactly `holders` hold the `admin` relation on platform.
const adminStoreOf = (holders: ReadonlyArray<string>): Layer.Layer<RelationStore> =>
	Layer.succeed(RelationStore, {
		has: (tuple) => Effect.succeed(tuple.relation === "admin" && holders.includes(tuple.subject)),
		hasSubjects: ({subjects, relation}) =>
			Effect.succeed(
				new Set(relation === "admin" ? subjects.filter((s) => holders.includes(s)) : []),
			),
		subjectsOf: ({relation}) => Effect.succeed(new Set(relation === "admin" ? holders : [])),
	});

const requestContext = (actor: Actor, on: boolean) =>
	flagsStub(on).pipe(
		Layer.provideMerge(Layer.succeed(CurrentUser, {user: undefined})),
		Layer.provideMerge(Layer.succeed(CurrentActor, {actor})),
		Layer.provideMerge(Layer.succeed(RuntimeContext, runtimeContextStub)),
	);

const banUser = (userId: string, reason: string) =>
	resolveWire(mutations["user.banUser"], {
		input: {userId, reason},
		select: ["id", "banned", "reason", "expiresAt"],
	});

const unbanUser = (userId: string) =>
	resolveWire(mutations["user.unbanUser"], {
		input: {userId},
		select: ["id", "banned", "reason", "expiresAt"],
	});

const wireCodeOf = (cause: Cause.Cause<unknown>): unknown => {
	const error = Cause.findErrorOption(cause);
	return error._tag === "Some" ? (error.value as {code?: unknown}).code : undefined;
};

// A `Pasaport` that fails on ANY contact — proving a denied path never reached the write.
const noWriteReached = Layer.mergeAll(makePasaportStub(), agentAuthorityStub);

describe("user.banUser — admin authority (fail closed)", () => {
	it.effect("an admin bans a target; the ban write runs and reports banned", () =>
		Effect.gen(function* () {
			const receipt = yield* banUser("u-target", "spam");
			assert.strictEqual((receipt as {banned: boolean}).banned, true);
			assert.strictEqual((receipt as {reason: string | null}).reason, "spam");
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					makePasaportStub({
						banUser: () => Effect.succeed({banned: true, reason: "spam", expiresAt: null}),
					}),
					adminStoreOf(["u-admin"]),
					agentAuthorityStub,
					requestContext(human("u-admin"), true),
				),
			),
		),
	);

	it.effect("a non-admin gets the invisible UNAUTHORIZED — and never reaches the write", () =>
		Effect.gen(function* () {
			const exit = yield* banUser("u-target", "spam").pipe(Effect.exit);
			assert.isTrue(Exit.isFailure(exit));
			if (Exit.isFailure(exit)) assert.strictEqual(wireCodeOf(exit.cause), "UNAUTHORIZED");
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					noWriteReached,
					adminStoreOf(["someone-else"]),
					requestContext(human("u-rando"), true),
				),
			),
		),
	);

	it.effect("the anonymous actor gets the SAME invisible UNAUTHORIZED", () =>
		Effect.gen(function* () {
			const exit = yield* banUser("u-target", "spam").pipe(Effect.exit);
			assert.isTrue(Exit.isFailure(exit));
			if (Exit.isFailure(exit)) assert.strictEqual(wireCodeOf(exit.cause), "UNAUTHORIZED");
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					noWriteReached,
					adminStoreOf(["u-admin"]),
					requestContext(unauthenticated, true),
				),
			),
		),
	);

	it.effect("a blank reason fails BAN_REASON_REQUIRED even for an admin", () =>
		Effect.gen(function* () {
			const exit = yield* banUser("u-target", "   ").pipe(Effect.exit);
			assert.isTrue(Exit.isFailure(exit));
			if (Exit.isFailure(exit)) assert.strictEqual(wireCodeOf(exit.cause), "BAN_REASON_REQUIRED");
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					noWriteReached,
					adminStoreOf(["u-admin"]),
					requestContext(human("u-admin"), true),
				),
			),
		),
	);

	it.effect("with the #970 flag OFF the path is inert — no authority check, no write", () =>
		Effect.gen(function* () {
			const exit = yield* banUser("u-target", "spam").pipe(Effect.exit);
			assert.isTrue(Exit.isFailure(exit));
			// Flag-off is the invisible Denied (UNAUTHORIZED), the same code a non-admin sees.
			if (Exit.isFailure(exit)) assert.strictEqual(wireCodeOf(exit.cause), "UNAUTHORIZED");
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					noWriteReached,
					// Authority must NOT be consulted when the flag is off.
					Layer.succeed(RelationStore, {
						has: () => Effect.die(new Error("flag OFF must not check authority")),
						hasSubjects: () => Effect.die(new Error("flag OFF must not check authority")),
						subjectsOf: () => Effect.die(new Error("flag OFF must not check authority")),
					}),
					requestContext(human("u-admin"), false),
				),
			),
		),
	);
});

describe("user.unbanUser — admin authority (fail closed)", () => {
	it.effect("an admin unbans a target; access is restored (not banned)", () =>
		Effect.gen(function* () {
			const receipt = yield* unbanUser("u-target");
			assert.strictEqual((receipt as {banned: boolean}).banned, false);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					makePasaportStub({
						unbanUser: () => Effect.succeed({banned: false, reason: null, expiresAt: null}),
					}),
					adminStoreOf(["u-admin"]),
					agentAuthorityStub,
					requestContext(human("u-admin"), true),
				),
			),
		),
	);

	it.effect("a non-admin gets the invisible UNAUTHORIZED — and never reaches the write", () =>
		Effect.gen(function* () {
			const exit = yield* unbanUser("u-target").pipe(Effect.exit);
			assert.isTrue(Exit.isFailure(exit));
			if (Exit.isFailure(exit)) assert.strictEqual(wireCodeOf(exit.cause), "UNAUTHORIZED");
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					noWriteReached,
					adminStoreOf(["someone-else"]),
					requestContext(human("u-rando"), true),
				),
			),
		),
	);
});
