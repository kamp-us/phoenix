/**
 * `user.setRole` WIRE-boundary coverage (#3522), driven through `resolveWire` so the
 * assertions are on the wire `code` a client actually gets.
 *
 * The load-bearing AC: setRole FAILS CLOSED. A non-admin and the anonymous actor get the
 * SAME invisible `UNAUTHORIZED` — neither can tell "not admin" from "not signed in" (ADR
 * 0098 §2) — and neither reaches the write. With the dark-ship flag off the path is inert
 * before any authority check. The real-D1 tuple round-trip is an integration concern.
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
	Type: "role-test",
	id: "role-test",
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

const setRole = (userId: string, role: "member" | "moderator") =>
	resolveWire(mutations["user.setRole"], {
		input: {userId, role},
		select: ["id", "role"],
	});

const wireCodeOf = (cause: Cause.Cause<unknown>): unknown => {
	const error = Cause.findErrorOption(cause);
	return error._tag === "Some" ? (error.value as {code?: unknown}).code : undefined;
};

// Fails on ANY contact, so a denied path that reached the write fails the test.
const noWriteReached = Layer.mergeAll(makePasaportStub(), agentAuthorityStub);

describe("user.setRole — admin authority (fail closed)", () => {
	it.effect("an admin grants moderator; the write runs and echoes the assigned role", () =>
		Effect.gen(function* () {
			const receipt = yield* setRole("u-target", "moderator");
			assert.strictEqual((receipt as {role: string}).role, "moderator");
			assert.strictEqual((receipt as {id: string}).id, "u-target");
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					makePasaportStub({
						setRole: (input) => Effect.succeed({role: input.role}),
					}),
					adminStoreOf(["u-admin"]),
					agentAuthorityStub,
					requestContext(human("u-admin"), true),
				),
			),
		),
	);

	it.effect("an admin revokes moderator (role member); the write runs and echoes member", () =>
		Effect.gen(function* () {
			const receipt = yield* setRole("u-target", "member");
			assert.strictEqual((receipt as {role: string}).role, "member");
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					makePasaportStub({
						setRole: (input) => Effect.succeed({role: input.role}),
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
			const exit = yield* setRole("u-target", "moderator").pipe(Effect.exit);
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
			const exit = yield* setRole("u-target", "moderator").pipe(Effect.exit);
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

	it.effect("with the #3522 flag OFF the path is inert — no authority check, no write", () =>
		Effect.gen(function* () {
			const exit = yield* setRole("u-target", "moderator").pipe(Effect.exit);
			assert.isTrue(Exit.isFailure(exit));
			// Flag-off must be indistinguishable from a non-admin denial.
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
